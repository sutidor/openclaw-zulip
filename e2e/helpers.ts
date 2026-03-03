/**
 * E2E test helpers: polling, assertions, topic generation.
 */

import type { ZulipClient, ZulipMessage } from "./zulip-client.js";
import type { E2EConfig } from "./config.js";

/** Generate a unique topic name for test isolation. */
export function uniqueTopic(scenario: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  return `e2e-${scenario}-${ts}-${rand}`;
}

/** Sleep for the given milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll for messages matching a predicate until one is found or timeout.
 * Returns matching messages or throws on timeout.
 */
export async function waitForMessages(params: {
  client: ZulipClient;
  config: E2EConfig;
  stream: string;
  topic: string;
  predicate: (msg: ZulipMessage) => boolean;
  minCount?: number;
  timeoutMs?: number;
  label?: string;
}): Promise<ZulipMessage[]> {
  const {
    client,
    config,
    stream,
    topic,
    predicate,
    minCount = 1,
    timeoutMs = config.responseTimeoutMs,
    label = "message",
  } = params;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await client.getMessages({ stream, topic });
    const matches = messages.filter(predicate);
    if (matches.length >= minCount) return matches;
    await sleep(config.pollIntervalMs);
  }
  throw new Error(
    `Timeout waiting for ${label} (${minCount} match(es)) in ${stream} > ${topic}`,
  );
}

/**
 * Assert that NO messages matching a predicate appear within the timeout.
 * Returns true if the assertion holds; throws if unexpected messages found.
 */
export async function assertNoMessages(params: {
  client: ZulipClient;
  config: E2EConfig;
  stream: string;
  topic: string;
  predicate: (msg: ZulipMessage) => boolean;
  timeoutMs?: number;
  label?: string;
}): Promise<void> {
  const {
    client,
    config,
    stream,
    topic,
    predicate,
    timeoutMs = config.negativeTimeoutMs,
    label = "message",
  } = params;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await client.getMessages({ stream, topic });
    const matches = messages.filter(predicate);
    if (matches.length > 0) {
      const senders = matches.map((m) => m.sender_email).join(", ");
      throw new Error(
        `Unexpected ${label} found from: ${senders} in ${stream} > ${topic}`,
      );
    }
    await sleep(config.pollIntervalMs);
  }
}

/**
 * Wait for a reaction on a message matching criteria.
 */
export async function waitForReaction(params: {
  client: ZulipClient;
  config: E2EConfig;
  messageId: number;
  emojiName?: string;
  fromEmail?: string;
  fromUserId?: number;
  timeoutMs?: number;
  label?: string;
}): Promise<ZulipMessage> {
  const {
    client,
    config,
    messageId,
    emojiName,
    fromEmail,
    fromUserId,
    timeoutMs = config.responseTimeoutMs,
    label = "reaction",
  } = params;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await client.getMessage(messageId);
    const match = msg.reactions?.some(
      (r) =>
        (!emojiName || r.emoji_name === emojiName) &&
        (!fromEmail || r.user?.email === fromEmail) &&
        (!fromUserId || r.user_id === fromUserId),
    );
    if (match) return msg;
    await sleep(config.pollIntervalMs);
  }
  throw new Error(
    `Timeout waiting for ${label} on message ${messageId}` +
      (emojiName ? ` (emoji: ${emojiName})` : "") +
      (fromEmail ? ` (from: ${fromEmail})` : ""),
  );
}

/**
 * Assert NO reaction matching criteria appears on a message within timeout.
 */
export async function assertNoReaction(params: {
  client: ZulipClient;
  config: E2EConfig;
  messageId: number;
  emojiName?: string;
  fromEmail?: string;
  fromUserId?: number;
  timeoutMs?: number;
  label?: string;
}): Promise<void> {
  const {
    client,
    config,
    messageId,
    emojiName,
    fromEmail,
    fromUserId,
    timeoutMs = config.negativeTimeoutMs,
    label = "reaction",
  } = params;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await client.getMessage(messageId);
    const match = msg.reactions?.some(
      (r) =>
        (!emojiName || r.emoji_name === emojiName) &&
        (!fromEmail || r.user?.email === fromEmail) &&
        (!fromUserId || r.user_id === fromUserId),
    );
    if (match) {
      throw new Error(
        `Unexpected ${label} on message ${messageId}` +
          (emojiName ? ` (emoji: ${emojiName})` : "") +
          (fromEmail ? ` (from: ${fromEmail})` : ""),
      );
    }
    await sleep(config.pollIntervalMs);
  }
}

/** Helper: check if a message is from one of the bot accounts. */
export function isFromBot(msg: ZulipMessage, config: E2EConfig): boolean {
  return config.allBotEmails.some(
    (e) => e.toLowerCase() === msg.sender_email.toLowerCase(),
  );
}

/** Helper: check if a message is from a specific email. */
export function isFrom(msg: ZulipMessage, email: string): boolean {
  return msg.sender_email.toLowerCase() === email.toLowerCase();
}

export type ScenarioResult = {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
};
