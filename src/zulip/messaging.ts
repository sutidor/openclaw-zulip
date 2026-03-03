import { normalizeStreamName } from "./normalize.js";
import { zulipRequest } from "./client.js";
import type { ZulipAuth } from "./client.js";
import type { ZulipEventMessage } from "./monitor-types.js";

export function shouldIgnoreMessage(params: {
  message: ZulipEventMessage;
  botUserId: number;
  streams: string[];
}): { ignore: boolean; reason?: string } {
  const msg = params.message;
  if (msg.sender_id === params.botUserId) {
    return { ignore: true, reason: "self" };
  }
  if (msg.type !== "stream") {
    return { ignore: true, reason: "dm" };
  }
  const stream = normalizeStreamName(msg.display_recipient);
  if (!stream) {
    return { ignore: true, reason: "missing-stream" };
  }
  if (params.streams.length > 0 && !params.streams.includes(stream)) {
    return { ignore: true, reason: "not-allowed-stream" };
  }
  return { ignore: false };
}

/**
 * Send a one-time "I only work in streams" reply to DM senders.
 * Uses a Set to avoid spamming the same sender repeatedly.
 */
export async function replyToDm(params: {
  auth: ZulipAuth;
  senderId: number;
  dmNotifiedSenders: Set<number>;
  log?: (message: string) => void;
}): Promise<void> {
  if (params.dmNotifiedSenders.has(params.senderId)) {
    return;
  }
  params.dmNotifiedSenders.add(params.senderId);
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/messages",
      form: {
        type: "direct",
        to: JSON.stringify([params.senderId]),
        content:
          "👋 I only work in Zulip streams — mention me in a stream to chat! DMs are not supported.",
      },
    });
    params.log?.(`[zulip] sent DM redirect to user ${params.senderId}`);
  } catch (err) {
    params.log?.(`[zulip] failed to send DM redirect: ${String(err)}`);
  }
}

export async function sendTypingIndicator(params: {
  auth: ZulipAuth;
  streamId: number;
  topic: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/typing",
      form: {
        op: "start",
        type: "stream",
        stream_id: params.streamId,
        topic: params.topic,
      },
      abortSignal: params.abortSignal,
    });
  } catch {
    // Best effort — typing indicators are non-critical.
  }
}

/**
 * Start a typing indicator and refresh it every `intervalMs` (default 10s).
 * Returns a cleanup function that stops the refresh interval.
 */
export function startTypingRefresh(params: {
  auth: ZulipAuth;
  streamId: number;
  topic: string;
  abortSignal?: AbortSignal;
  intervalMs?: number;
}): () => void {
  sendTypingIndicator(params).catch(() => undefined);
  const interval = setInterval(() => {
    sendTypingIndicator(params).catch(() => undefined);
  }, params.intervalMs ?? 10_000);
  return () => clearInterval(interval);
}

export async function stopTypingIndicator(params: {
  auth: ZulipAuth;
  streamId: number;
  topic: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/typing",
      form: {
        op: "stop",
        type: "stream",
        stream_id: params.streamId,
        topic: params.topic,
      },
      abortSignal: params.abortSignal,
    });
  } catch {
    // Best effort — typing indicators are non-critical.
  }
}
