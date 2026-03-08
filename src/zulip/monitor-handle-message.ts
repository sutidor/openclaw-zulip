import type { ReplyPayload } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import { clearDispatchTracking, hasToolSentToTopic } from "./dispatch-state.js";
import { normalizeMentions } from "./mention-cache.js";
import {
  isAutoReplyStream,
  listEnabledZulipAccounts,
  type ZulipReactionWorkflowStage,
} from "./accounts.js";
import {
  DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS,
  DELIVERY_GRACE_MS,
  DELIVERY_TIMEOUT_MS,
  NO_REPLY_PATTERN,
} from "./constants.js";
import {
  buildZulipCheckpointId,
  clearZulipInFlightCheckpoint,
  markZulipCheckpointFailure,
  prepareZulipCheckpointForRecovery,
  type ZulipInFlightCheckpoint,
  ZULIP_INFLIGHT_CHECKPOINT_VERSION,
  writeZulipInFlightCheckpoint,
} from "./inflight-checkpoints.js";
import { normalizeStreamName, normalizeTopic } from "./normalize.js";
import { sendZulipStreamMessage } from "./send.js";
import { downloadZulipUploads } from "./uploads.js";
import { sleep } from "./sleep.js";
import { waitForDispatcherIdleWithTimeout } from "./backoff.js";
import { createBestEffortShutdownNoticeSender, startPeriodicKeepalive } from "./keepalive.js";
import { deliverReply } from "./deliver.js";
import { shouldIgnoreMessage, startTypingRefresh, stopTypingIndicator } from "./messaging.js";
import {
  bestEffortReaction,
  createReactionTransitionController,
  withWorkflowReactionStages,
} from "./reaction-workflow.js";
import { resolveCanonicalTopicSessionKey } from "./topic-rename.js";
import type { MonitorContext, ZulipEventMessage } from "./monitor-types.js";

export async function handleMessage(
  mctx: MonitorContext,
  msg: ZulipEventMessage,
  messageOptions?: { recoveryCheckpoint?: ZulipInFlightCheckpoint },
): Promise<void> {
  const { account, auth, cfg, core, logger, runtime, opts, abortSignal, dedupe, topicAliasesByStream } = mctx;

  if (typeof msg.id !== "number") {
    return;
  }
  if (dedupe.check(String(msg.id))) {
    return;
  }
  const ignore = shouldIgnoreMessage({ message: msg, botUserId: mctx.botUserId, streams: account.streams });
  if (ignore.ignore) {
    return;
  }

  const isRecovery = Boolean(messageOptions?.recoveryCheckpoint);
  const stream = normalizeStreamName(msg.display_recipient);
  const topic = normalizeTopic(msg.subject) || account.defaultTopic;
  const content = msg.content ?? "";
  if (!stream) {
    return;
  }
  if (isRecovery) {
    logger.warn(
      `[zulip:${account.accountId}] replaying recovery checkpoint for message ${msg.id} (${stream}#${topic})`,
    );
  }
  // Defer the definitive empty-content check until after upload processing —
  // image-only messages have content (upload URLs) that gets stripped later,
  // but should still be processed as media. Quick pre-check: bail only if
  // content is truly blank AND contains no upload references at all.
  if (!content.trim() && !content.includes("/user_uploads/")) {
    return;
  }

  // --- Mention evaluation (must run before bot-to-bot filter) ---
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "zulip",
    accountId: account.accountId,
    peer: { kind: "channel" as const, id: stream },
  });
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
  // Extract only explicit Zulip @**Name** mentions for matching. Running the
  // SDK matcher against the full message body causes false positives when an
  // agent name appears in plain text (e.g. "discussed with Amira" triggers
  // Amira's mention gate even though there's no @mention).
  const withoutSilentMentions = content.replace(/@_\*\*[^*]+\*\*/g, "");
  const mentionMatches = [...withoutSilentMentions.matchAll(/@\*\*([^*]+)\*\*/g)];
  const explicitMentions = mentionMatches
    .map((m) => `@${m[1]}`)
    .join(" ")
    // Strip leading emoji prefixes from Zulip display names so "@📐 BotB"
    // matches the SDK mention regex built from agent identity name "BotB".
    .replace(/@([\p{Emoji_Presentation}\p{Extended_Pictographic}]+\s*)/gu, "@");
  const cleanedForMentions = explicitMentions;
  // Also support email-prefix mentions (e.g. @**amira-bot**) alongside
  // display-name mentions. LLMs sometimes use the Zulip username instead
  // of the display name when composing @mentions.
  const extractedMentionNames = mentionMatches.map((m) => m[1].toLowerCase());
  const mentionMatchesEmailPrefix = (email: string | undefined): boolean => {
    if (!email) return false;
    const prefix = email.split("@")[0]?.toLowerCase();
    return Boolean(prefix && extractedMentionNames.includes(prefix));
  };
  const wasMentioned = (cleanedForMentions.length > 0
    && core.channel.mentions.matchesMentionPatterns(cleanedForMentions, mentionRegexes))
    || mentionMatchesEmailPrefix(account.email);

  // --- Bot-to-bot filter (mention-aware, applies to ALL accounts) ---
  // When the sender is a sibling bot and this bot was NOT @mentioned, skip
  // to prevent circular reply loops. When @mentioned by a sibling bot,
  // process normally (enables bot-to-bot delegation via visible @mentions).
  const siblingBotEmails = new Set(
    listEnabledZulipAccounts(cfg)
      .filter((a) => a.accountId !== account.accountId)
      .map((a) => a.email?.toLowerCase())
      .filter((e): e is string => Boolean(e)),
  );
  const senderIsSiblingBot = Boolean(
    msg.sender_email && siblingBotEmails.has(msg.sender_email.toLowerCase()),
  );
  if (senderIsSiblingBot && !wasMentioned) {
    logger.debug?.(
      `[${account.accountId}] ignoring sibling bot message from ${msg.sender_email} in ${stream}#${topic}`,
    );
    return;
  }

  core.channel.activity.record({
    channel: "zulip",
    accountId: account.accountId,
    direction: "inbound",
    at: Date.now(),
  });
  opts.statusSink?.({ lastInboundAt: Date.now(), lastEventAt: Date.now() });

  // --- Mention gate ---
  const isAutoReply = isAutoReplyStream(account, stream);

  // Non-auto-reply context: only respond when @mentioned.
  if (!isAutoReply && !wasMentioned) {
    logger.debug?.(
      `[${account.accountId}] skipping message in ${stream}#${topic} (not mentioned, no auto-reply)`,
    );
    return;
  }

  // Auto-reply but not mentioned: defer if another bot IS @mentioned.
  if (isAutoReply && !wasMentioned) {
    const otherAccounts = listEnabledZulipAccounts(cfg).filter(
      (a) => a.accountId !== account.accountId,
    );
    for (const other of otherAccounts) {
      const otherRoute = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "zulip",
        accountId: other.accountId,
        peer: { kind: "channel" as const, id: stream },
      });
      const otherRegexes = core.channel.mentions.buildMentionRegexes(cfg, otherRoute.agentId);
      if (
        core.channel.mentions.matchesMentionPatterns(cleanedForMentions, otherRegexes) ||
        mentionMatchesEmailPrefix(other.email)
      ) {
        logger.debug?.(
          `[${account.accountId}] deferring to ${other.accountId} in ${stream}#${topic}`,
        );
        return;
      }
    }
  }
  // --- End mention gate ---

  // --- Notification Bot filter: suppress LLM dispatch for "topic resolved" ---
  if (
    msg.sender_email === "notification-bot@zulip.com" &&
    /has marked this topic as resolved/.test(content)
  ) {
    logger.debug?.(
      `[${account.accountId}] skipping reply for topic-resolved notification in ${stream}#${topic}`,
    );
    return;
  }

  // Per-handler delivery signal: allows reply delivery to complete even if the monitor
  // is stopping (e.g. gateway restart). Without this, in-flight HTTP calls to Zulip get
  // aborted immediately, wasting the LLM tokens already spent generating the response.
  const deliveryController = new AbortController();
  const deliverySignal = deliveryController.signal;
  const deliveryTimer = setTimeout(() => {
    if (!deliveryController.signal.aborted) deliveryController.abort();
  }, DELIVERY_TIMEOUT_MS);
  const onMainAbortForDelivery = () => {
    // Give in-flight deliveries a grace period to finish before hard abort
    setTimeout(() => {
      if (!deliveryController.signal.aborted) deliveryController.abort();
    }, DELIVERY_GRACE_MS);
  };
  abortSignal.addEventListener("abort", onMainAbortForDelivery, { once: true });

  const sendShutdownNoticeOnce = createBestEffortShutdownNoticeSender({
    sendNotice: async () => {
      await sendZulipStreamMessage({
        auth,
        stream,
        topic,
        content:
          "♻️ Gateway restart in progress - reconnecting now. If this turn is interrupted, please resend in a moment.",
        abortSignal: deliverySignal,
      });
    },
    log: (message) => logger.debug?.(message),
  });
  const onMainAbortShutdownNotice = () => {
    sendShutdownNoticeOnce();
  };
  abortSignal.addEventListener("abort", onMainAbortShutdownNotice, { once: true });
  if (abortSignal.aborted) {
    onMainAbortShutdownNotice();
  }

  const reactions = account.reactions;
  // Bot-to-bot reaction suppression: skip workflow reactions when sender is
  // a sibling bot and this bot was NOT @mentioned. When @mentioned by a
  // sibling bot, use the normal reaction pattern.
  const suppressReactions = senderIsSiblingBot && !wasMentioned;
  const reactionController =
    reactions.enabled && reactions.workflow.enabled && !suppressReactions
      ? createReactionTransitionController({
          auth,
          messageId: msg.id,
          reactions,
          log: (m) => logger.debug?.(m),
        })
      : null;

  if (reactionController) {
    await reactionController.transition("queued", { abortSignal });
  } else if (reactions.enabled && !suppressReactions) {
    await bestEffortReaction({
      auth,
      messageId: msg.id,
      op: "add",
      emojiName: reactions.onStart,
      log: (m) => logger.debug?.(m),
      abortSignal,
    });
  }

  // Typing indicator: start + refresh, stop on completion
  const stopTypingRefresh =
    typeof msg.stream_id === "number"
      ? startTypingRefresh({ auth, streamId: msg.stream_id, topic, abortSignal })
      : undefined;

  const inboundUploads = await downloadZulipUploads({
    cfg,
    accountId: account.accountId,
    auth,
    content,
    abortSignal,
  });
  const mediaPaths = inboundUploads.map((entry) => entry.path);
  const mediaUrls = inboundUploads.map((entry) => entry.url);
  const mediaTypes = inboundUploads.map((entry) => entry.contentType ?? "");

  // Strip downloaded upload URLs from the content so the native image loader
  // doesn't try to open raw /user_uploads/... paths as local files.
  let cleanedContent = content;
  for (const upload of inboundUploads) {
    cleanedContent = cleanedContent.replaceAll(upload.url, upload.placeholder);
    try {
      const urlObj = new URL(upload.url);
      cleanedContent = cleanedContent.replaceAll(urlObj.pathname, upload.placeholder);
    } catch {
      // Ignore URL parse errors.
    }
  }

  // Now that uploads are resolved, bail if there's truly nothing to process:
  // no text content AND no media attachments.
  if (!cleanedContent.trim() && inboundUploads.length === 0) {
    return;
  }

  const baseSessionKey = route.sessionKey;
  const canonicalTopicKey = resolveCanonicalTopicSessionKey({
    aliasesByStream: topicAliasesByStream,
    stream,
    topic,
  });
  const sessionKey = `${baseSessionKey}:topic:${canonicalTopicKey}`;

  const to = `stream:${stream}#${topic}`;
  const from = `zulip:channel:${stream}`;
  const senderName =
    msg.sender_full_name?.trim() || msg.sender_email?.trim() || String(msg.sender_id);

  const body = core.channel.reply.formatInboundEnvelope({
    channel: "Zulip",
    from: `${stream} (${topic || account.defaultTopic})`,
    timestamp: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
    body: `${cleanedContent}\n[zulip message id: ${msg.id} stream: ${stream} topic: ${topic}]`,
    chatType: "channel",
    sender: { name: senderName, id: String(msg.sender_id) },
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: cleanedContent,
    CommandBody: cleanedContent,
    From: from,
    To: to,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: "channel",
    ThreadLabel: topic,
    MessageThreadId: topic,
    ConversationLabel: `${stream}#${topic}`,
    GroupSubject: stream,
    GroupChannel: `#${stream}`,
    GroupSystemPrompt: isAutoReply
      ? "Always reply to every message in this Zulip stream/topic.\n\nIMPORTANT: If the message is a simple acknowledgment with nothing actionable (examples: 'thanks', 'ok', 'got it', 'noted', 'sure', 'np', 'cool', 'great', 'thx', 'ty', 'perfect', 'awesome', 'sounds good', 'will do', 'roger', 'hmm'), respond with EXACTLY the text NO_REPLY and nothing else — no quotes, no markdown, just the raw text NO_REPLY.\n\nDelegation: When delegating to another agent, @mention them in your reply text (e.g. @amira-bot). Do NOT use the message send tool for this — write exactly one reply that includes the @mention.\n\nTo start a new topic, prefix your reply with: [[zulip_topic: <topic>]]"
      : undefined,
    Provider: "zulip" as const,
    Surface: "zulip" as const,
    SenderName: senderName,
    SenderId: String(msg.sender_id),
    MessageSid: String(msg.id),
    WasMentioned: wasMentioned,
    OriginatingChannel: "zulip" as const,
    OriginatingTo: to,
    Timestamp: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
    MediaPath: mediaPaths[0],
    MediaUrl: mediaUrls[0],
    MediaType: mediaTypes[0],
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    CommandAuthorized: true,
  });

  const nowMs = Date.now();
  let checkpoint: ZulipInFlightCheckpoint = messageOptions?.recoveryCheckpoint
    ? prepareZulipCheckpointForRecovery({
        checkpoint: messageOptions.recoveryCheckpoint,
        nowMs,
      })
    : {
        version: ZULIP_INFLIGHT_CHECKPOINT_VERSION,
        checkpointId: buildZulipCheckpointId({
          accountId: account.accountId,
          messageId: msg.id,
        }),
        accountId: account.accountId,
        stream,
        topic,
        messageId: msg.id,
        senderId: String(msg.sender_id),
        senderName,
        senderEmail: msg.sender_email,
        cleanedContent,
        body,
        sessionKey,
        from,
        to,
        wasMentioned,
        streamId: msg.stream_id,
        timestampMs: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
        mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
        mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        retryCount: 0,
      };
  try {
    await writeZulipInFlightCheckpoint({ checkpoint });
  } catch (err) {
    runtime.error?.(`[zulip] failed to persist in-flight checkpoint: ${String(err)}`);
  }

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "zulip",
    accountId: account.accountId,
  });

  let successfulDeliveries = 0;
  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload: ReplyPayload) => {
        // Suppress NO_REPLY sentinel — the LLM chose not to reply (e.g. "thanks", "ok").
        const replyText = (payload.text ?? "").trim();
        if (NO_REPLY_PATTERN.test(replyText)) {
          logger.debug?.(
            `[${account.accountId}] NO_REPLY suppressed for ${stream}#${topic}`,
          );
          // Best-effort acknowledgment reaction on the user's inbound message.
          await bestEffortReaction({
            auth,
            messageId: msg.id,
            op: "add",
            emojiName: "thumbs_up",
            log: (m) => logger.debug?.(m),
            abortSignal: deliverySignal,
          });
          return;
        }
        // Suppress redundant text reply when the send tool already sent to this topic.
        if (hasToolSentToTopic(account.accountId, stream, topic)) {
          logger.debug?.(
            `[${account.accountId}] suppressing text reply (tool already sent to ${stream}#${topic})`,
          );
          return;
        }
        // Normalize outgoing @mentions: replace plain "@emailPrefix" or
        // "@**emailPrefix**" with proper Zulip "@**Display Name**" mentions.
        const normalizedPayload = normalizeMentions(payload, mctx.mentionDisplayNames);
        // Use deliverySignal (not abortSignal) so in-flight replies survive
        // monitor shutdown with a grace period instead of being killed instantly.
        await deliverReply({
          account,
          auth,
          stream,
          topic,
          payload: normalizedPayload,
          cfg,
          abortSignal: deliverySignal,
        });
        successfulDeliveries += 1;
        opts.statusSink?.({ lastOutboundAt: Date.now(), lastEventAt: Date.now() });
        core.channel.activity.record({
          channel: "zulip",
          accountId: account.accountId,
          direction: "outbound",
          at: Date.now(),
        });
      },
      onError: (err: unknown) => {
        runtime.error?.(`zulip reply failed: ${String(err)}`);
      },
    });
  const dispatchDriver = reactionController
    ? withWorkflowReactionStages(dispatcher, reactions, reactionController, abortSignal)
    : dispatcher;

  const stopKeepalive = startPeriodicKeepalive({
    sendPing: async (_elapsedMs) => {
      if (reactionController) {
        await reactionController.transition("toolRunning", { abortSignal: deliverySignal });
      }
      // No visible message — reaction emoji is the keepalive signal.
    },
  });

  let ok = false;
  let lastDispatchError: unknown;
  const MAX_DISPATCH_RETRIES = 2;
  try {
    for (let attempt = 0; attempt <= MAX_DISPATCH_RETRIES; attempt++) {
      try {
        if (reactionController) {
          await reactionController.transition("processing", { abortSignal });
        }
        await core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher: dispatchDriver,
          replyOptions: {
            ...replyOptions,
            disableBlockStreaming: true,
            onModelSelected,
          },
        });
        ok = true;
        lastDispatchError = undefined;
        break;
      } catch (err) {
        ok = false;
        lastDispatchError = err;
        const isRetryable =
          attempt < MAX_DISPATCH_RETRIES &&
          !(err instanceof Error && err.name === "AbortError");
        if (isRetryable) {
          if (reactionController) {
            await reactionController.transition("retrying", { abortSignal });
          }
          runtime.error?.(
            `zulip dispatch failed (attempt ${attempt + 1}/${MAX_DISPATCH_RETRIES + 1}, retrying in 2s): ${String(err)}`,
          );
          await sleep(2000, abortSignal).catch(() => undefined);
          continue;
        }
        opts.statusSink?.({ lastError: err instanceof Error ? err.message : String(err) });
        runtime.error?.(`zulip dispatch failed: ${String(err)}`);
      }
    }
  } finally {
    // Ensure all queued outbound sends are flushed before cleanup.
    dispatcher.markComplete();
    try {
      await waitForDispatcherIdleWithTimeout({
        waitForIdle: () => dispatcher.waitForIdle(),
        timeoutMs: DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS,
        onTimeout: () => {
          logger.warn(
            `[zulip] dispatcher.waitForIdle timed out after ${DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS}ms; continuing cleanup`,
          );
        },
      });
    } finally {
      markDispatchIdle();
      clearDispatchTracking(account.accountId);
      // Clean up periodic keepalive timers.
      stopKeepalive();
      // Clean up typing refresh interval (before stopTypingIndicator)
      stopTypingRefresh?.();
      // Clean up delivery abort controller listener/timer (do not hard-abort here).
      clearTimeout(deliveryTimer);
      abortSignal.removeEventListener("abort", onMainAbortForDelivery);
      abortSignal.removeEventListener("abort", onMainAbortShutdownNotice);

      // Stop typing indicator now that the reply has been sent.
      if (typeof msg.stream_id === "number") {
        stopTypingIndicator({
          auth,
          streamId: msg.stream_id,
          topic,
          abortSignal: deliverySignal,
        }).catch(() => undefined);
      }

      // Visible failure message: post an actual user-visible message when dispatch fails
      if (ok === false) {
        try {
          await sendZulipStreamMessage({
            auth,
            stream,
            topic,
            content:
              "⚠️ I ran into an error processing your message — please try again. (Error has been logged)",
            abortSignal: deliverySignal,
          });
        } catch {
          // Best effort — if this fails, at least the reaction emoji will show the failure
        }
      }

      // Use deliverySignal for final reactions so they can still be posted
      // during graceful shutdown (the grace period covers these too).
      if (reactions.enabled) {
        if (reactionController) {
          const finalStage: ZulipReactionWorkflowStage = ok
            ? "success"
            : successfulDeliveries > 0
              ? "partialSuccess"
              : "failure";
          await reactionController.transition(finalStage, {
            abortSignal: deliverySignal,
            force: true,
          });
        } else {
          if (reactions.clearOnFinish) {
            await bestEffortReaction({
              auth,
              messageId: msg.id,
              op: "remove",
              emojiName: reactions.onStart,
              log: (m) => logger.debug?.(m),
              abortSignal: deliverySignal,
            });
          }
          const finalEmoji = ok ? reactions.onSuccess : reactions.onFailure;
          await bestEffortReaction({
            auth,
            messageId: msg.id,
            op: "add",
            emojiName: finalEmoji,
            log: (m) => logger.debug?.(m),
            abortSignal: deliverySignal,
          });
        }
      }

      try {
        if (ok) {
          await clearZulipInFlightCheckpoint({ checkpointId: checkpoint.checkpointId });
        } else {
          checkpoint = markZulipCheckpointFailure({
            checkpoint,
            error: lastDispatchError ?? "dispatch failed",
          });
          await writeZulipInFlightCheckpoint({ checkpoint });
        }
      } catch (err) {
        runtime.error?.(`[zulip] failed to update in-flight checkpoint: ${String(err)}`);
      }
    }
  }
}

