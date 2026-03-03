/**
 * Scenario R6: Silent mention (@_**Name**) → no response from that bot.
 *
 * Parties: sim-user, coordinator (BotA), specialist (BotB)
 *
 * Success criterion: sim-user sends a message with a silent mention
 * of the specialist. The specialist does NOT respond.
 *
 * Expected behavior per bot:
 * - Coordinator (BotA): the mention gate strips the silent mention
 *   (@_**Name**) before evaluation, so the message has no real
 *   @mention — coordinator replies as the default handler (R1).
 * - Specialist (BotB): silent mention is stripped before the mention
 *   gate runs; specialist is NOT triggered, produces no text reply
 *   and no reactions.
 */

import type { ZulipClient } from "../zulip-client.js";
import type { E2EConfig } from "../config.js";
import {
  uniqueTopic,
  waitForMessages,
  assertNoMessages,
  isFrom,
} from "../helpers.js";
import type { ScenarioResult } from "../helpers.js";

export async function run(
  client: ZulipClient,
  config: E2EConfig,
): Promise<ScenarioResult> {
  const name = "R6-silent-mention";
  const start = Date.now();
  const topic = uniqueTopic("r6");

  try {
    // Send a message with a silent mention of the specialist
    await client.sendMessage(
      config.stream,
      topic,
      `I discussed this with @_**${config.specialistDisplayName}** already. Thoughts?`,
    );

    // Wait for coordinator to reply (it's an unmentioned message,
    // coordinator should handle it)
    await waitForMessages({
      client,
      config,
      stream: config.stream,
      topic,
      predicate: (msg) => isFrom(msg, config.coordinatorEmail),
      label: "coordinator reply",
    });

    // Assert specialist did NOT respond (silent mention should not trigger)
    await assertNoMessages({
      client,
      config,
      stream: config.stream,
      topic,
      predicate: (msg) => isFrom(msg, config.specialistEmail),
      label: "specialist reply (should not exist — silent mention)",
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
