import type { ZulipHttpError } from "./client.js";
import { zulipRequest } from "./client.js";
import { FRESHNESS_INTERVAL_MS, MAX_CONCURRENT_HANDLERS } from "./constants.js";
import type {
  MonitorContext,
  ZulipEventMessage,
  ZulipReactionEvent,
  ZulipEvent,
} from "./monitor-types.js";
import { registerQueue, pollEvents } from "./monitor-api.js";
import { replyToDm } from "./messaging.js";
import { parseTopicRenameEvent, recordTopicRenameAlias } from "./topic-rename.js";
import { sleep } from "./sleep.js";
import { computeZulipMonitorBackoffMs, extractZulipHttpStatus } from "./backoff.js";

export type PollStreamHandlers = {
  handleMessage: (msg: ZulipEventMessage) => Promise<void>;
  handleReaction: (reactionEvent: ZulipReactionEvent) => Promise<void>;
  rememberReactionContext: (msg: ZulipEventMessage) => void;
};

export async function pollStreamQueue(
  mctx: MonitorContext,
  stream: string,
  handlers: PollStreamHandlers,
): Promise<void> {
  const { account, auth, logger, runtime, botUserId, dmNotifiedSenders, topicAliasesByStream, abortSignal } = mctx;

  let queueId = "";
  let lastEventId = -1;
  let retry = 0;
  let stage: "register" | "poll" | "handle" = "register";

  // Backpressure: limit concurrent message handlers to prevent unbounded pile-up.
  let activeHandlers = 0;
  const handlerWaiters: Array<() => void> = [];

  const throttledHandleMessage = async (msg: ZulipEventMessage) => {
    if (activeHandlers >= MAX_CONCURRENT_HANDLERS) {
      await new Promise<void>((resolve) => handlerWaiters.push(resolve));
    }
    activeHandlers++;
    try {
      await handlers.handleMessage(msg);
    } finally {
      activeHandlers--;
      const next = handlerWaiters.shift();
      if (next) next();
    }
  };

  // Freshness checker: periodically verify we haven't missed messages during
  // long-poll gaps, queue re-registrations, or silent connection drops.
  let lastSeenMsgId = 0;
  const freshnessTimer = setInterval(async () => {
    if (mctx.stopped() || abortSignal.aborted || lastSeenMsgId === 0) return;
    try {
      const recent = await zulipRequest<{ result: string; messages?: ZulipEventMessage[] }>({
        auth,
        method: "GET",
        path: "/api/v1/messages",
        query: {
          anchor: "newest",
          num_before: 5,
          num_after: 0,
          narrow: JSON.stringify([["channel", stream]]),
          apply_markdown: "false",
        },
        abortSignal,
      });
      if (recent.result === "success" && recent.messages) {
        let caught = 0;
        for (const msg of recent.messages) {
          if (typeof msg.id === "number" && msg.id > lastSeenMsgId) {
            caught++;
            lastSeenMsgId = msg.id;
            throttledHandleMessage(msg).catch((err) => {
              runtime.error?.(`zulip: freshness catchup failed: ${String(err)}`);
            });
          }
        }
        if (caught > 0) {
          logger.warn(
            `[zulip:${account.accountId}] freshness checker recovered ${caught} missed message(s) in stream "${stream}"`,
          );
        }
      }
    } catch {
      // Best effort — freshness check is non-critical.
    }
  }, FRESHNESS_INTERVAL_MS);

  while (!mctx.stopped() && !abortSignal.aborted) {
    try {
      if (!queueId) {
        stage = "register";
        const wasReregistration = lastEventId !== -1;
        const reg = await registerQueue({ auth, stream, abortSignal });
        queueId = reg.queueId;
        lastEventId = reg.lastEventId;

        // Recover messages lost during queue gap on re-registration.
        if (wasReregistration) {
          try {
            const recent = await zulipRequest<{
              result: string;
              messages?: ZulipEventMessage[];
            }>({
              auth,
              method: "GET",
              path: "/api/v1/messages",
              query: {
                anchor: "newest",
                num_before: 10,
                num_after: 0,
                narrow: JSON.stringify([["channel", stream]]),
                apply_markdown: "false",
              },
              abortSignal,
            });
            if (recent.result === "success" && recent.messages) {
              let caught = 0;
              for (const msg of recent.messages) {
                if (typeof msg.id === "number" && msg.id > lastSeenMsgId) {
                  lastSeenMsgId = msg.id;
                  caught++;
                  throttledHandleMessage(msg).catch((err) => {
                    runtime.error?.(`zulip: catchup message failed: ${String(err)}`);
                  });
                }
              }
              if (caught > 0) {
                logger.warn(
                  `[zulip:${account.accountId}] re-registration catchup recovered ${caught} missed message(s) in stream "${stream}"`,
                );
              }
            }
          } catch (catchupErr) {
            logger.debug?.(
              `[zulip:${account.accountId}] catchup fetch failed: ${String(catchupErr)}`,
            );
          }
        }
      }

      stage = "poll";
      const events = await pollEvents({ auth, queueId, lastEventId, abortSignal });
      if (events.result !== "success") {
        throw new Error(events.msg || "Zulip events poll failed");
      }

      const list = events.events ?? [];
      // Update lastEventId from individual event IDs.
      for (const evt of list) {
        if (typeof evt.id === "number" && evt.id > lastEventId) {
          lastEventId = evt.id;
        }
      }

      // Every successful poll (even empty) proves the socket is alive — report
      // lastEventAt before handler dispatch so long-running handlers don't
      // prevent the health-monitor from seeing liveness.
      mctx.opts.statusSink?.({ lastEventAt: Date.now() });

      for (const evt of list) {
        const rename = parseTopicRenameEvent(evt);
        if (!rename) {
          continue;
        }
        const mapped = recordTopicRenameAlias({
          aliasesByStream: topicAliasesByStream,
          stream,
          fromTopic: rename.fromTopic,
          toTopic: rename.toTopic,
        });
        if (mapped) {
          logger.info(
            `[zulip:${account.accountId}] mapped topic rename alias for stream "${stream}": "${rename.toTopic}" -> "${rename.fromTopic}"`,
          );
        }
      }

      const messages = list
        .map((evt) => evt.message)
        .filter((m): m is ZulipEventMessage => Boolean(m));

      for (const msg of messages) {
        handlers.rememberReactionContext(msg);
      }

      // Track highest message ID for freshness checker gap detection.
      for (const msg of messages) {
        if (typeof msg.id === "number" && msg.id > lastSeenMsgId) {
          lastSeenMsgId = msg.id;
        }
      }

      // Handle reaction events
      const reactionEvents = list
        .filter((evt): evt is ZulipEvent & ZulipReactionEvent => evt.type === "reaction")
        .map((evt) => evt as ZulipReactionEvent);

      for (const reactionEvent of reactionEvents) {
        try {
          await handlers.handleReaction(reactionEvent);
        } catch (err) {
          logger.warn(
            `[zulip:${account.accountId}] reaction handling failed: ${String(err)}`,
          );
        }
      }

      // Handle DMs by sending a redirect notice.
      const dmMessages = messages.filter(
        (m) => m.type !== "stream" && m.sender_id !== botUserId,
      );
      for (const dm of dmMessages) {
        if (typeof dm.sender_id === "number") {
          logger.debug?.(`[zulip:${account.accountId}] ignoring DM from user ${dm.sender_id}`);
          replyToDm({
            auth,
            senderId: dm.sender_id,
            dmNotifiedSenders,
            log: (m) => logger.debug?.(m),
          }).catch(() => undefined);
        }
      }

      // Defensive throttle: if Zulip responds immediately without any message payloads
      if (messages.length === 0 && reactionEvents.length === 0) {
        const jitterMs = Math.floor(Math.random() * 250);
        await sleep(2000 + jitterMs, abortSignal).catch(() => undefined);
        retry = 0;
        continue;
      }

      stage = "handle";
      for (const msg of messages) {
        // Use throttled handler with backpressure (max concurrent limit)
        throttledHandleMessage(msg).catch((err) => {
          runtime.error?.(`zulip: message processing failed: ${String(err)}`);
        });
        // Small stagger between starting each message for natural pacing
        await sleep(200, abortSignal).catch(() => undefined);
      }

      retry = 0;
    } catch (err) {
      if (mctx.stopped()) {
        break;
      }

      const status = extractZulipHttpStatus(err);
      const retryAfterMs = (err as ZulipHttpError).retryAfterMs;

      // Always clear queueId on ANY error to force re-registration
      queueId = "";

      const isAbortError =
        err instanceof Error &&
        (err.name === "AbortError" ||
          err.message?.includes("aborted") ||
          err.message?.includes("timeout") ||
          err.message?.includes("ETIMEDOUT"));

      if (isAbortError) {
        logger.warn(
          `[zulip:${account.accountId}] poll timeout/abort detected (stream=${stream}, stage=${stage}): ${String(err)} - forcing queue re-registration`,
        );
      }

      retry += 1;
      const backoffMs = computeZulipMonitorBackoffMs({
        attempt: retry,
        status,
        retryAfterMs,
      });
      logger.warn(
        `[zulip:${account.accountId}] monitor error (stream=${stream}, stage=${stage}, attempt=${retry}): ${String(err)} (retry in ${backoffMs}ms)`,
      );
      await sleep(backoffMs, abortSignal).catch(() => undefined);
    }
  }

  // Clean up freshness checker interval.
  clearInterval(freshnessTimer);

  // Clean up the server-side event queue on shutdown.
  if (queueId) {
    try {
      await zulipRequest({
        auth,
        method: "DELETE",
        path: "/api/v1/events",
        form: { queue_id: queueId },
      });
    } catch {
      // Best effort — server will expire it anyway.
    }
  }
}
