/**
 * Scenario R3: Reaction on bot message invokes callback.
 *
 * Parties: sim-user, coordinator (BotA)
 *
 * Tests each recognized reaction emoji independently. Each emoji has
 * different semantics and should produce a meaningfully different
 * follow-up from the bot:
 *
 * - thumbs_up  — approve/execute (bot should carry out the plan)
 * - cross_mark — cancel/reject   (bot should acknowledge cancellation)
 * - repeat     — retry           (bot should try a different approach)
 * - back       — undo/rollback   (bot should revert or offer to undo)
 * - thinking   — reconsider/elaborate (bot should expand or rethink)
 *
 * Note: check (confirm/done) is intentionally excluded — the correct
 * behavior is for the bot to terminate without a text reply.
 *
 * Trigger: all emojis are in the default allowedEmojis list and the
 * reaction targets a message sent by the coordinator (genericCallback
 * only processes reactions on the bot's own messages). The initial
 * message asks the bot to propose something actionable so each
 * reaction semantically maps to a distinct follow-up.
 *
 * Expected behavior per bot:
 * - Coordinator (BotA): receives the unmentioned prompt, replies with
 *   a proposal. When sim-user reacts with a recognized emoji, the
 *   generic reaction callback fires — the coordinator dispatches a
 *   synthetic inbound with the original message context and emoji
 *   semantics, producing a follow-up text reply.
 * - Specialist (BotB): not directly involved — the reaction is on the
 *   coordinator's message, and genericCallback only fires for reactions
 *   on a bot's own messages.
 */

import type { E2EConfig } from "../config.js";
import {
  type ZulipClient,
  type ScenarioResult,
  uniqueTopic,
  waitForMessages,
  assertNoMessages,
  sleep,
  isFrom,
} from "@openclaw/e2e";

/** Each recognized reaction emoji and its semantic meaning. */
const REACTION_EMOJIS = [
  { emoji: "thumbs_up", meaning: "approve/execute" },
  { emoji: "cross_mark", meaning: "cancel/reject" },
  { emoji: "repeat", meaning: "retry" },
  { emoji: "back", meaning: "undo/rollback" },
  { emoji: "thinking", meaning: "reconsider/elaborate" },
] as const;

/** Emojis NOT in the default allowedEmojis list — bot should ignore these. */
const UNKNOWN_EMOJIS = ["rocket", "tada"] as const;

/** Send the prompt and wait for the coordinator to reply. Retries once on timeout. */
async function setupBotReply(
  client: ZulipClient,
  config: E2EConfig,
  label: string,
): Promise<{ topic: string; botMsgId: number }> {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const topic = uniqueTopic(`r3-${label}${attempt > 1 ? `-r${attempt}` : ""}`);
    await client.sendMessage(
      config.stream,
      topic,
      "Make an actionable plan to write a 3-line poem. Upon approval, write it.",
    );
    try {
      const botMessages = await waitForMessages({
        client,
        config,
        stream: config.stream,
        topic,
        predicate: (msg) => isFrom(msg, config.coordinatorEmail),
        label: `coordinator reply (setup for ${label}, attempt ${attempt})`,
      });
      return { topic, botMsgId: botMessages[0].id };
    } catch {
      if (attempt === maxAttempts) throw new Error(
        `Coordinator did not reply to setup prompt for ${label} after ${maxAttempts} attempts`,
      );
      await sleep(config.pollIntervalMs);
    }
  }
  throw new Error("unreachable");
}

async function testReaction(
  client: ZulipClient,
  config: E2EConfig,
  emoji: string,
  meaning: string,
): Promise<{ emoji: string; passed: boolean; error?: string }> {
  const reactionTimeoutMs = Number(
    process.env.E2E_REACTION_TIMEOUT_MS ?? "45000",
  );

  try {
    const { topic, botMsgId } = await setupBotReply(client, config, emoji);

    // React with the test emoji
    await client.addReaction(botMsgId, emoji);

    // Wait for the bot to respond to the reaction
    await sleep(config.pollIntervalMs);

    const allMessages = await waitForMessages({
      client,
      config,
      stream: config.stream,
      topic,
      predicate: (msg) =>
        isFrom(msg, config.coordinatorEmail) && msg.id > botMsgId,
      label: `reaction callback response (${emoji} = ${meaning})`,
      timeoutMs: reactionTimeoutMs,
    });

    if (allMessages.length === 0) {
      return { emoji, passed: false, error: `Bot did not respond to ${emoji} reaction` };
    }

    return { emoji, passed: true };
  } catch (err) {
    return {
      emoji,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test that certain emojis do NOT produce a text reply.
 * Used for both unknown emojis (not in allowedEmojis) and silent emojis
 * (allowed but expected to terminate without reply, e.g. check = "done").
 */
async function testNoReplyReactions(
  client: ZulipClient,
  config: E2EConfig,
  emojis: readonly string[],
  label: string,
): Promise<{ passed: boolean; error?: string }> {
  try {
    const { topic } = await setupBotReply(client, config, label);

    // Wait for the LLM to finish any self-continuation (plan → execution)
    // before adding reactions, so we get a clean baseline.
    await sleep(config.negativeTimeoutMs);

    // Snapshot the highest message ID after the topic has settled
    const settled = await client.getMessages({ stream: config.stream, topic });
    const highWater = settled.length > 0
      ? Math.max(...settled.map((m) => m.id))
      : 0;

    // React on the first bot message
    const botMsg = settled.find((m) => isFrom(m, config.coordinatorEmail));
    if (!botMsg) {
      return { passed: false, error: `No bot message found in settled topic for ${label}` };
    }
    for (const emoji of emojis) {
      await client.addReaction(botMsg.id, emoji);
    }

    // Assert no NEW follow-up from bot after the reactions
    await sleep(config.pollIntervalMs);
    await assertNoMessages({
      client,
      config,
      stream: config.stream,
      topic,
      predicate: (msg) =>
        isFrom(msg, config.coordinatorEmail) && msg.id > highWater,
      label: `no-reply reaction (${label}: ${emojis.join(", ")})`,
    });

    return { passed: true };
  } catch (err) {
    return {
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function run(
  client: ZulipClient,
  config: E2EConfig,
): Promise<ScenarioResult> {
  const name = "R3-reaction-callback";
  const start = Date.now();
  const failures: string[] = [];

  // Test known emojis — bot should respond to each
  for (const { emoji, meaning } of REACTION_EMOJIS) {
    const result = await testReaction(client, config, emoji, meaning);
    if (!result.passed) {
      failures.push(`${emoji} (${meaning}): ${result.error}`);
    }
  }

  // Test unknown emojis — bot should ignore (not in allowedEmojis)
  const unknownResult = await testNoReplyReactions(client, config, UNKNOWN_EMOJIS, "unknown");
  if (!unknownResult.passed) {
    failures.push(`unknown emojis (${UNKNOWN_EMOJIS.join(", ")}): ${unknownResult.error}`);
  }

  const totalTests = REACTION_EMOJIS.length + 1;
  if (failures.length > 0) {
    return {
      name,
      passed: false,
      error: `${failures.length}/${totalTests} reaction tests failed:\n${failures.join("\n")}`,
      durationMs: Date.now() - start,
    };
  }

  return { name, passed: true, durationMs: Date.now() - start };
}
