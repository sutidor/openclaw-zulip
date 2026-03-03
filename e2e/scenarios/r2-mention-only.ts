/**
 * Scenario R2: @mention routes to specific bot only.
 *
 * Parties: sim-user, coordinator (BotA), specialist (BotB)
 *
 * Success criterion: user @mentions the specialist bot. Only that bot
 * replies. Coordinator and other bots stay silent.
 *
 * Expected behavior per bot:
 * - Specialist (BotB): receives the @mention, replies with text as
 *   the sole handler for this message (R2).
 * - Coordinator (BotA): sees the message in context, detects that
 *   another bot is @mentioned, defers — no text reply, no reactions.
 */

import type { ZulipClient } from "../zulip-client.js";
import type { E2EConfig } from "../config.js";
import {
  uniqueTopic,
  waitForMessages,
  assertNoMessages,
  isFrom,
  isFromBot,
} from "../helpers.js";
import type { ScenarioResult } from "../helpers.js";

export async function run(
  client: ZulipClient,
  config: E2EConfig,
): Promise<ScenarioResult> {
  const name = "R2-mention-only";
  const start = Date.now();
  const topic = uniqueTopic("r2");

  try {
    // @mention the specialist bot
    await client.sendMessage(
      config.stream,
      topic,
      `@**${config.specialistDisplayName}** ping`,
    );

    // Wait for specialist to reply
    await waitForMessages({
      client,
      config,
      stream: config.stream,
      topic,
      predicate: (msg) => isFrom(msg, config.specialistEmail),
      label: "specialist reply",
    });

    // Assert coordinator did NOT reply
    await assertNoMessages({
      client,
      config,
      stream: config.stream,
      topic,
      predicate: (msg) =>
        isFromBot(msg, config) &&
        !isFrom(msg, config.specialistEmail),
      label: "coordinator reply (should not exist)",
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
