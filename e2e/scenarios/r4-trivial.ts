/**
 * Scenario R4: Trivial message → emoji reaction only, no text.
 *
 * Parties: sim-user, coordinator (BotA)
 *
 * Success criterion: user says "thanks". Zero text reply from any bot.
 * Bot reacts with emoji (e.g., 👍) on the user's message.
 *
 * Trigger: "thanks" is a trivial acknowledgment. The coordinator's
 * LLM responds with NO_REPLY, the suppression code adds a best-effort
 * 👍 reaction on the user's inbound message (msg.id) per R4.
 *
 * Expected behavior per bot:
 * - Coordinator (BotA): receives "thanks", LLM returns NO_REPLY,
 *   suppression code adds 👍 reaction on the user's trivial message,
 *   zero text is sent.
 * - Specialist (BotB): not involved — unmentioned message handled by
 *   coordinator only (R1). Specialist ingests context but produces no
 *   output.
 */

import type { ZulipClient } from "../zulip-client.js";
import type { E2EConfig } from "../config.js";
import {
  uniqueTopic,
  waitForMessages,
  waitForReaction,
  assertNoMessages,
  isFrom,
  isFromBot,
} from "../helpers.js";
import type { ScenarioResult } from "../helpers.js";

export async function run(
  client: ZulipClient,
  config: E2EConfig,
): Promise<ScenarioResult> {
  const name = "R4-trivial-emoji-only";
  const start = Date.now();
  const topic = uniqueTopic("r4");

  try {
    // First send a substantive message to establish context
    await client.sendMessage(
      config.stream,
      topic,
      "What is 2+2?",
    );

    // Wait for coordinator reply to establish conversation
    const msgs = await waitForMessages({
      client,
      config,
      stream: config.stream,
      topic,
      predicate: (msg) => isFrom(msg, config.coordinatorEmail),
      label: "coordinator reply",
    });

    // Now send a trivial acknowledgment
    const trivialMsgId = await client.sendMessage(
      config.stream,
      topic,
      "thanks",
    );

    // Wait for an emoji reaction on the trivial message from any bot
    await waitForReaction({
      client,
      config,
      messageId: trivialMsgId,
      label: "acknowledgment reaction on trivial message",
    });

    // Assert NO text reply from any bot after the trivial message
    await assertNoMessages({
      client,
      config,
      stream: config.stream,
      topic,
      predicate: (msg) =>
        isFromBot(msg, config) &&
        msg.id > msgs[0].id &&
        msg.id !== trivialMsgId,
      label: "text reply to trivial message (should not exist)",
    });

    return { name, passed: true, durationMs: Date.now() - start };
  } catch (err) {
    return {
      name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}
