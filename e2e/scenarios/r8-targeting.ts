/**
 * Scenario R8: Reply and reaction targeting correctness.
 *
 * Parties: sim-user, coordinator (BotA)
 *
 * Success criteria:
 * - Reply text targets the correct stream/topic (same as triggering message)
 * - Workflow reactions target the triggering message (not the bot's reply)
 * - Bot does NOT add reactions to its own reply message
 *
 * Expected behavior per bot:
 * - Coordinator (BotA): receives unmentioned question, replies with text
 *   in the same topic, and adds workflow reactions (eyes → check) on
 *   the user's triggering message (sentMsgId), NOT on the bot's own
 *   reply message.
 * - Specialist (BotB): not directly involved — unmentioned message is
 *   handled by coordinator only (R1). Specialist ingests context but
 *   produces no output.
 */

import type { ZulipClient } from "../zulip-client.js";
import type { E2EConfig } from "../config.js";
import {
  uniqueTopic,
  waitForMessages,
  waitForReaction,
  assertNoReaction,
  isFrom,
} from "../helpers.js";
import type { ScenarioResult } from "../helpers.js";

export async function run(
  client: ZulipClient,
  config: E2EConfig,
): Promise<ScenarioResult> {
  const name = "R8-targeting-correctness";
  const start = Date.now();
  const topic = uniqueTopic("r8");

  try {
    // Resolve coordinator user ID for reaction matching (Zulip API returns
    // user_id on reactions, not email)
    const coordUser = await client.getUserByEmail(config.coordinatorEmail);

    // Send a message and track its ID
    const sentMsgId = await client.sendMessage(
      config.stream,
      topic,
      "Explain what a prime number is in one sentence.",
    );

    // Wait for coordinator reply
    const replyMessages = await waitForMessages({
      client,
      config,
      stream: config.stream,
      topic,
      predicate: (msg) => isFrom(msg, config.coordinatorEmail),
      label: "coordinator reply",
    });

    const botReplyId = replyMessages[0].id;

    // Check 1: Reply is in the correct topic
    const topicMessages = await client.getMessages({
      stream: config.stream,
      topic,
    });
    const botReplies = topicMessages.filter((m) =>
      isFrom(m, config.coordinatorEmail),
    );
    if (botReplies.length === 0) {
      throw new Error("Coordinator reply not found in expected topic");
    }

    // Check 2: Workflow reaction (check) is on the user's triggering message
    await waitForReaction({
      client,
      config,
      messageId: sentMsgId,
      fromUserId: coordUser.user_id,
      label: "workflow reaction on triggering message",
    });

    // Check 3: No reactions from coordinator on its own reply message
    await assertNoReaction({
      client,
      config,
      messageId: botReplyId,
      fromUserId: coordUser.user_id,
      label: "reaction on bot's own reply (should not exist)",
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
