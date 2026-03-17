import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { getZulipRuntime } from "../runtime.js";
import { resolveZulipAccount } from "./accounts.js";
import { createDedupeCache, type DedupeCache } from "./dedupe.js";
import type { ZulipInFlightCheckpoint } from "./inflight-checkpoints.js";
import { buildZulipQueuePlan } from "./queue-plan.js";
import {
  startReactionButtonSessionCleanup,
  stopReactionButtonSessionCleanup,
} from "./reaction-buttons.js";
import { sendZulipStreamMessage } from "./send.js";
import type {
  MonitorZulipOptions,
  ZulipEventMessage,
  ZulipReactionEvent,
} from "./monitor-types.js";
import { buildAuth, fetchZulipMe, fetchZulipUser } from "./monitor-api.js";
import { listEnabledZulipAccounts } from "./accounts.js";
import { updateMentionDisplayNames } from "./mention-cache.js";
import { createReactionMessageContextTracker } from "./monitor-reaction-context.js";
import { handleMessage as handleMessageImpl } from "./monitor-handle-message.js";
import { handleReaction as handleReactionImpl } from "./monitor-handle-reaction.js";
import { replayPendingCheckpoints as replayPendingCheckpointsImpl } from "./monitor-checkpoint-replay.js";
import { pollStreamQueue } from "./monitor-poll.js";

/**
 * Tracks whether the restart notice has already been posted in this process.
 * Prevents health-monitor socket recycling from sending duplicate notices.
 */
const startupNoticeSent = new Set<string>();

/**
 * Dedupe caches keyed by accountId. Module-level so they survive
 * health-monitor socket cycling (stopChannel → startChannel).
 */
const dedupeCacheByAccount = new Map<string, DedupeCache>();

/** @internal — test-only reset for module-level state */
export function _resetModuleStateForTest(): void {
  startupNoticeSent.clear();
  dedupeCacheByAccount.clear();
}

export async function monitorZulipProvider(
  opts: MonitorZulipOptions,
): Promise<{ stop: () => void }> {
  const core = getZulipRuntime();
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveZulipAccount({
    cfg,
    accountId: opts.accountId,
  });
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (message: string) => core.logging.getChildLogger().info(message),
    error: (message: string) => core.logging.getChildLogger().error(message),
    exit: () => {
      throw new Error("Runtime exit not available");
    },
  };

  const logger = core.logging.getChildLogger({ channel: "zulip", accountId: account.accountId });

  if (!account.baseUrl || !account.email || !account.apiKey) {
    throw new Error(`Zulip credentials missing for account "${account.accountId}"`);
  }
  if (!account.streams.length) {
    throw new Error(
      `Zulip streams allowlist missing for account "${account.accountId}" (set channels.zulip.streams)`,
    );
  }

  const auth = buildAuth(account);
  const abortController = new AbortController();
  const abortSignal = abortController.signal;
  let stopped = false;
  const stop = () => {
    stopped = true;
    abortController.abort();
  };
  opts.abortSignal?.addEventListener("abort", stop, { once: true });

  const run = async () => {
    // Start reaction button session cleanup
    startReactionButtonSessionCleanup();

    const me = await fetchZulipMe(auth, abortSignal);
    if (me.result !== "success" || typeof me.user_id !== "number") {
      throw new Error(me.msg || "Failed to fetch Zulip bot identity");
    }
    const botUserId = me.user_id;

    // Build email-prefix → Zulip display name mapping for all accounts.
    // Used to normalize outgoing @mentions (e.g. "@amira-bot" → "@**📐 Amira**").
    // Also collects sibling bot user IDs for reaction filtering.
    const mentionDisplayNames = new Map<string, string>();
    const siblingBotUserIds = new Set<number>();
    if (me.email && me.full_name) {
      mentionDisplayNames.set(me.email.split("@")[0].toLowerCase(), me.full_name);
    }
    const allAccounts = listEnabledZulipAccounts(cfg);
    const siblingFetches = allAccounts
      .filter((a) => a.accountId !== account.accountId && a.email)
      .map(async (a) => {
        const user = await fetchZulipUser(auth, a.email!, abortSignal);
        if (user) {
          if (user.full_name && a.email) {
            mentionDisplayNames.set(a.email.split("@")[0].toLowerCase(), user.full_name);
          }
          siblingBotUserIds.add(user.user_id);
        }
      });
    await Promise.all(siblingFetches).catch(() => undefined);
    updateMentionDisplayNames(mentionDisplayNames);

    // Dedupe cache prevents reprocessing messages after queue re-registration or reconnect.
    // Module-level so it survives health-monitor socket cycling.
    let dedupe = dedupeCacheByAccount.get(account.accountId);
    if (!dedupe) {
      dedupe = createDedupeCache({ ttlMs: 5 * 60 * 1000, maxSize: 500 });
      dedupeCacheByAccount.set(account.accountId, dedupe);
    }

    // Track DM senders we've already notified to avoid spam.
    const dmNotifiedSenders = new Set<number>();
    // Topic-rename alias map per stream: renamed-topic-key -> canonical-topic-key.
    const topicAliasesByStream = new Map<string, Map<string, string>>();

    const mctx: import("./monitor-types.js").MonitorContext = {
      account, auth, cfg, core, logger, runtime, opts,
      abortSignal, botUserId, dedupe, dmNotifiedSenders, topicAliasesByStream,
      mentionDisplayNames, siblingBotUserIds,
      stopped: () => stopped,
    };

    const handleMessage = (
      msg: ZulipEventMessage,
      messageOptions?: { recoveryCheckpoint?: ZulipInFlightCheckpoint },
    ) => handleMessageImpl(mctx, msg, messageOptions);

    const resumedCheckpointIds = new Set<string>();

    const reactionTracker = createReactionMessageContextTracker({
      auth,
      defaultTopic: account.defaultTopic,
      abortSignal,
    });

    const handleReaction = (reactionEvent: ZulipReactionEvent) =>
      handleReactionImpl(mctx, reactionEvent, reactionTracker);

    await replayPendingCheckpointsImpl(mctx, handleMessage, resumedCheckpointIds);

    const plan = buildZulipQueuePlan(account.streams);
    if (plan.length === 0) {
      throw new Error(
        `Zulip streams allowlist missing for account "${account.accountId}" (set channels.zulip.streams)`,
      );
    }

    // Send a one-time startup notice.  If restartNoticeAccount is set, only
    // that account posts the notice; otherwise fall back to alwaysReply accounts.
    // Uses startupNoticeSent to suppress duplicate notices from health-monitor
    // socket recycling (stale-socket restarts within the same process).
    const zulipCfg = cfg.channels?.zulip as Record<string, unknown> | undefined;
    const startupNoticeTopic = zulipCfg?.restartNoticeTopic as string | undefined;
    const restartNoticeAccount = zulipCfg?.restartNoticeAccount as string | undefined;
    const noticeKey = `${account.accountId}:${startupNoticeTopic ?? ""}`;
    const shouldPostNotice = restartNoticeAccount
      ? account.accountId === restartNoticeAccount
      : account.alwaysReply;
    if (shouldPostNotice && startupNoticeTopic && plan.length > 0 && !startupNoticeSent.has(noticeKey)) {
      startupNoticeSent.add(noticeKey);
      sendZulipStreamMessage({
        auth,
        stream: plan[0].stream,
        topic: startupNoticeTopic,
        content: "♻️ Gateway restarted — all systems online.",
        abortSignal,
      }).catch((err) => {
        logger.debug?.(`[${account.accountId}] startup notice failed: ${String(err)}`);
      });
    }

    await Promise.all(
      plan.map((entry) =>
        pollStreamQueue(mctx, entry.stream, {
          handleMessage,
          handleReaction,
          rememberReactionContext: (msg) => reactionTracker.remember(msg),
        }),
      ),
    );
  };

  const done = run()
    .catch((err) => {
      if (abortSignal.aborted || stopped) {
        return;
      }
      opts.statusSink?.({ lastError: err instanceof Error ? err.message : String(err) });
      runtime.error?.(`[zulip:${account.accountId}] monitor crashed: ${String(err)}`);
    })
    .finally(() => {
      // Clean up reaction button sessions
      stopReactionButtonSessionCleanup();
    });

  return { stop, done };
}
