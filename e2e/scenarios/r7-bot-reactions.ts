/**
 * Scenario R7: Bot-to-bot workflow reaction behavior.
 *
 * Parties: sim-user, coordinator (BotA), specialist (BotB)
 *
 * Tests two cases from the spec:
 *
 * Phase 1 — Negative: unmentioned bot message → no workflow reactions.
 *   Coordinator replies to sim-user's question. Specialist sees the
 *   coordinator's reply (sibling bot, no @mention) and MUST NOT add any
 *   workflow reactions (eyes, check, warning) to it.
 *
 * Phase 2 — Positive: @mentioned bot message → normal workflow reactions.
 *   Sim-user @mentions the specialist. Specialist processes the message
 *   and MUST add workflow reactions on the triggering message (same
 *   reaction pattern as for human messages).
 */

import type { E2EConfig } from "../config.js";
import {
  type ZulipClient,
  type ScenarioResult,
  uniqueTopic,
  waitForMessages,
  waitForReaction,
  sleep,
  isFrom,
} from "@openclaw/e2e";

const WORKFLOW_EMOJIS = ["eyes", "check", "warning"];

export async function run(
  client: ZulipClient,
  config: E2EConfig,
): Promise<ScenarioResult> {
  const name = "R7-bot-reaction-suppression";
  const start = Date.now();

  try {
    // Resolve specialist user ID upfront for reaction matching (Zulip API
    // returns user_id on reactions, not email)
    const specialistUser = await client.getUserByEmail(config.specialistEmail);

    // ── Phase 1: unmentioned → no specialist reactions ──────────────

    let topic = "";
    let coordMsgId = 0;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      topic = uniqueTopic(`r7-neg${attempt > 1 ? `-r${attempt}` : ""}`);
      await client.sendMessage(config.stream, topic, "What is the capital of France?");
      try {
        const coordMessages = await waitForMessages({
          client,
          config,
          stream: config.stream,
          topic,
          predicate: (msg) => isFrom(msg, config.coordinatorEmail),
          label: `coordinator reply (attempt ${attempt})`,
        });
        coordMsgId = coordMessages[0].id;
        break;
      } catch {
        if (attempt === maxAttempts) throw new Error(
          `Coordinator did not reply after ${maxAttempts} attempts`,
        );
        await sleep(config.pollIntervalMs);
      }
    }

    // Assert no workflow reactions from specialist on coordinator's message
    const deadline = Date.now() + config.negativeTimeoutMs;
    while (Date.now() < deadline) {
      const msg = await client.getMessage(coordMsgId);
      for (const emoji of WORKFLOW_EMOJIS) {
        const found = msg.reactions?.some(
          (r) =>
            r.emoji_name === emoji &&
            r.user_id === specialistUser.user_id,
        );
        if (found) {
          throw new Error(
            `Unexpected workflow reaction '${emoji}' from specialist on coordinator message ${coordMsgId}`,
          );
        }
      }
      await sleep(config.pollIntervalMs);
    }

    // ── Phase 2: @mentioned → specialist adds workflow reactions ────

    const posTopic = uniqueTopic("r7-pos");
    const triggerMsgId = await client.sendMessage(
      config.stream,
      posTopic,
      `@**${config.specialistDisplayName}** What is 3+3?`,
    );

    // Wait for specialist reply (proves it processed the message)
    await waitForMessages({
      client,
      config,
      stream: config.stream,
      topic: posTopic,
      predicate: (msg) => isFrom(msg, config.specialistEmail),
      label: "specialist reply to @mention",
    });

    // Assert specialist added a workflow reaction on the triggering message
    // (check = final success reaction after processing)
    await waitForReaction({
      client,
      config,
      messageId: triggerMsgId,
      fromUserId: specialistUser.user_id,
      label: "specialist workflow reaction on @mentioned message",
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
