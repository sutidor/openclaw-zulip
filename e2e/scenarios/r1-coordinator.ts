/**
 * Scenario R1: Unmentioned message → only coordinator replies.
 *
 * Parties: sim-user, coordinator (BotA), specialist (BotB)
 *
 * Success criterion: user sends a message with no @mention. Only the
 * coordinator bot replies. Specialist bots stay silent.
 *
 * Expected behavior per bot:
 * - Coordinator (BotA): receives the message, replies with text (sole
 *   responder for unmentioned messages per R1).
 * - Specialist (BotB): ingests the message into conversation context
 *   but does NOT reply and does NOT react (not mentioned, not
 *   coordinator).
 */

import type { ZulipClient } from "../zulip-client.js";
import type { E2EConfig } from "../config.js";
import {
  uniqueTopic,
  waitForMessages,
  assertNoMessages,
  sleep,
  isFrom,
  isFromBot,
} from "../helpers.js";
import type { ScenarioResult } from "../helpers.js";

export async function run(
  client: ZulipClient,
  config: E2EConfig,
): Promise<ScenarioResult> {
  const name = "R1-coordinator-only";
  const start = Date.now();

  try {
    // Send an unmentioned message; retry once on timeout (LLM cold-start)
    let topic = "";
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      topic = uniqueTopic(`r1${attempt > 1 ? `-r${attempt}` : ""}`);
      await client.sendMessage(config.stream, topic, "What is 1+1?");
      try {
        await waitForMessages({
          client,
          config,
          stream: config.stream,
          topic,
          predicate: (msg) => isFrom(msg, config.coordinatorEmail),
          label: `coordinator reply (attempt ${attempt})`,
        });
        break;
      } catch {
        if (attempt === maxAttempts) throw new Error(
          `Coordinator did not reply after ${maxAttempts} attempts`,
        );
        await sleep(config.pollIntervalMs);
      }
    }

    // Assert specialist did NOT reply
    await assertNoMessages({
      client,
      config,
      stream: config.stream,
      topic,
      predicate: (msg) =>
        isFromBot(msg, config) &&
        !isFrom(msg, config.coordinatorEmail),
      label: "specialist reply (should not exist)",
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
