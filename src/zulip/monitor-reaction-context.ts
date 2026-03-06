import type { ReplyPayload } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import type { ZulipAuth } from "./client.js";
import { zulipRequest } from "./client.js";
import { NO_REPLY_PATTERN } from "./constants.js";
import type { MonitorContext, ZulipEventMessage, ZulipReactionEvent } from "./monitor-types.js";
import { normalizeStreamName, normalizeTopic } from "./normalize.js";
import { sendZulipStreamMessage } from "./send.js";
import { startTypingRefresh, stopTypingIndicator } from "./messaging.js";

// ---------------------------------------------------------------------------
// Reaction message context tracker
// ---------------------------------------------------------------------------

const REACTION_MESSAGE_CONTEXT_TTL_MS = 30 * 60 * 1000;
const REACTION_MESSAGE_CONTEXT_MAX = 1_000;

export type ReactionMessageContextTracker = {
  remember: (msg: ZulipEventMessage) => void;
  resolve: (event: ZulipReactionEvent) => Promise<{
    stream: string;
    topic: string;
    streamId?: number;
    senderId?: number;
  } | null>;
  toCommandToken: (emojiName: string) => string;
};

function normalizeReactionSourceFromMessage(
  message: ZulipEventMessage | undefined,
  defaultTopic: string,
) {
  if (!message) {
    return null;
  }
  if (message.type && message.type !== "stream") {
    return null;
  }
  const stream = normalizeStreamName(
    typeof message.display_recipient === "string" ? message.display_recipient : "",
  );
  const topic = normalizeTopic(message.subject) || defaultTopic;
  if (!stream || !topic) {
    return null;
  }
  return { stream, topic };
}

export function createReactionMessageContextTracker(params: {
  auth: ZulipAuth;
  defaultTopic: string;
  abortSignal?: AbortSignal;
}): ReactionMessageContextTracker {
  const contexts = new Map<number, { stream: string; topic: string; streamId?: number; senderId?: number; capturedAt: number }>();

  const remember = (msg: ZulipEventMessage) => {
    if (typeof msg.id !== "number") {
      return;
    }
    const source = normalizeReactionSourceFromMessage(msg, params.defaultTopic);
    if (!source) {
      return;
    }
    contexts.set(msg.id, { ...source, streamId: msg.stream_id, senderId: msg.sender_id, capturedAt: Date.now() });
    if (contexts.size > REACTION_MESSAGE_CONTEXT_MAX) {
      for (const [messageId] of contexts) {
        contexts.delete(messageId);
        if (contexts.size <= REACTION_MESSAGE_CONTEXT_MAX) {
          break;
        }
      }
    }
  };

  const resolve = async (
    reactionEvent: ZulipReactionEvent,
  ): Promise<{ stream: string; topic: string; streamId?: number; senderId?: number } | null> => {
    const fromEvent = normalizeReactionSourceFromMessage(reactionEvent.message, params.defaultTopic);
    if (fromEvent) {
      contexts.set(reactionEvent.message_id, { ...fromEvent, streamId: reactionEvent.message?.stream_id, senderId: reactionEvent.message?.sender_id, capturedAt: Date.now() });
      return {
        ...fromEvent,
        streamId: reactionEvent.message?.stream_id,
        senderId: reactionEvent.message?.sender_id,
      };
    }

    const cached = contexts.get(reactionEvent.message_id);
    if (cached) {
      if (Date.now() - cached.capturedAt > REACTION_MESSAGE_CONTEXT_TTL_MS) {
        contexts.delete(reactionEvent.message_id);
      } else {
        return { stream: cached.stream, topic: cached.topic, streamId: cached.streamId, senderId: cached.senderId };
      }
    }

    // Fallback: fetch message from Zulip API when event doesn't include it
    try {
      const response = await zulipRequest({
        auth: params.auth,
        method: "GET",
        path: `/api/v1/messages/${reactionEvent.message_id}`,
        abortSignal: params.abortSignal,
      });
      const msg = (response as { message?: ZulipEventMessage }).message;
      const fetched = normalizeReactionSourceFromMessage(msg, params.defaultTopic);
      if (fetched && msg) {
        contexts.set(reactionEvent.message_id, { ...fetched, capturedAt: Date.now() });
        return { ...fetched, streamId: msg.stream_id, senderId: msg.sender_id };
      }
    } catch {
      // Best effort — if API call fails, return null
    }
    return null;
  };

  const toCommandToken = (emojiName: string) => {
    const normalized = emojiName
      .trim()
      .toLowerCase()
      .replace(/^:/, "")
      .replace(/:$/, "")
      .replace(/[^a-z0-9_+-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return normalized || "emoji";
  };

  return { remember, resolve, toCommandToken };
}

// ---------------------------------------------------------------------------
// Synthetic reaction context dispatcher
// ---------------------------------------------------------------------------

export type SyntheticReactionParams = {
  stream: string;
  topic: string;
  body: string;
  rawBody: string;
  commandBody: string;
  sessionKeySuffix: string;
  userId: number;
  userName: string;
  messageSid: string;
  systemPrompt: string;
  errorLabel: string;
  sessionKeyOverride?: string;
  streamId?: number;
  agentId?: string;
};

export function dispatchSyntheticReactionContext(
  mctx: MonitorContext,
  params: SyntheticReactionParams,
): void {
  const { account, auth, cfg, core, logger, abortSignal } = mctx;
  const target = `stream:${params.stream}#${params.topic}`;
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: params.body,
    RawBody: params.rawBody || params.body,
    CommandBody: params.body,
    From: `zulip:user:${params.userId}`,
    To: target,
    SessionKey: params.sessionKeyOverride ?? `zulip:${account.accountId}:reaction:${params.sessionKeySuffix}`,
    AccountId: account.accountId,
    ChatType: "channel",
    ThreadLabel: params.topic,
    MessageThreadId: params.topic,
    ConversationLabel: `${params.stream}#${params.topic}`,
    GroupSubject: params.stream,
    GroupChannel: `#${params.stream}`,
    GroupSystemPrompt: params.systemPrompt,
    Provider: "zulip" as const,
    Surface: "zulip" as const,
    SenderName: params.userName,
    SenderId: String(params.userId),
    MessageSid: params.messageSid,
    WasMentioned: true,
    OriginatingChannel: "zulip" as const,
    OriginatingTo: target,
    Timestamp: Date.now(),
    CommandAuthorized: true,
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: params.agentId,
    channel: "zulip",
    accountId: account.accountId,
  });

  const { dispatcher, replyOptions: dispatcherReplyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, params.agentId),
      deliver: async (payload: ReplyPayload) => {
        const text = (payload.text ?? "").trim();
        if (!text || NO_REPLY_PATTERN.test(text)) {
          return;
        }
        // Suppress internal error/warning diagnostics from being posted to the
        // stream. Tool failures (e.g. "Unknown target") are logged, not shown.
        if (/^(WARNING|ERROR)\s*:/i.test(text)) {
          logger.debug?.(`[zulip] suppressed reaction error output: ${text.slice(0, 120)}`);
          return;
        }
        await sendZulipStreamMessage({
          auth,
          stream: params.stream,
          topic: params.topic,
          content: payload.text!,
          abortSignal,
        });
      },
      onError: (err: unknown) => {
        logger.error?.(`[zulip] ${params.errorLabel} reply delivery failed: ${String(err)}`);
      },
    });

  // Typing indicator: start + refresh, stop on completion
  const stopTypingRefresh =
    typeof params.streamId === "number"
      ? startTypingRefresh({ auth, streamId: params.streamId, topic: params.topic, abortSignal })
      : undefined;

  void core.channel.reply
    .dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...dispatcherReplyOptions,
        disableBlockStreaming: true,
        onModelSelected,
      },
    })
    .catch((err: unknown) => {
      logger.error?.(`[zulip] ${params.errorLabel} dispatch failed: ${String(err)}`);
    })
    .finally(async () => {
      dispatcher.markComplete();
      try {
        await dispatcher.waitForIdle();
      } catch {
        // ignore
      }
      markDispatchIdle();
      stopTypingRefresh?.();
      if (typeof params.streamId === "number") {
        stopTypingIndicator({ auth, streamId: params.streamId, topic: params.topic, abortSignal }).catch(() => undefined);
      }
    });
}
