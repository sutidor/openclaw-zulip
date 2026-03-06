/**
 * Scenario R9: Cross-department question handled directly by coordinator.
 *
 * Parties: sim-user, coordinator (BotA)
 *
 * Success criterion: user asks a cross-department question that the
 * coordinator should handle directly (not route to a specialist). The
 * coordinator replies with a substantive answer rather than routing.
 *
 * This tests the "Direct Handling" path in cos-router:
 * - Cross-department coordination questions
 * - Business overview / status questions
 * - Questions that don't map to a single department
 */

import type { E2EConfig } from "../config.js";
import {
  type ZulipClient,
  type ScenarioResult,
  uniqueTopic,
  waitForMessages,
  assertNoMessages,
  isFrom,
  isFromBot,
  sleep,
} from "@openclaw/e2e";

export async function run(
  client: ZulipClient,
  config: E2EConfig,
): Promise<ScenarioResult> {
  const name = "R9-direct-handling";
  const start = Date.now();

  try {
    // Retry once for cold-start
    let topic = "";
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      topic = uniqueTopic(`r9${attempt > 1 ? `-r${attempt}` : ""}`);

      // Ask a simple cross-department question the coordinator should handle directly
      const sentMsgId = await client.sendMessage(
        config.stream,
        topic,
        "Which departments do we have and who is responsible for each?",
      );

      try {
        // Wait for coordinator reply (skip progress messages)
        await waitForMessages({
          client,
          config,
          stream: config.stream,
          topic,
          timeoutMs: 60_000, // cross-dept questions need more time
          predicate: (msg) =>
            isFrom(msg, config.coordinatorEmail) &&
            msg.id > sentMsgId &&
            msg.content.length > 40 &&
            !msg.content.toLowerCase().includes("still working") &&
            !msg.content.toLowerCase().includes("gateway restart"),
          label: `coordinator direct reply (attempt ${attempt})`,
        });
        break;
      } catch {
        if (attempt === maxAttempts)
          throw new Error(
            `Coordinator did not reply after ${maxAttempts} attempts`,
          );
        await sleep(config.pollIntervalMs);
      }
    }

    // Assert specialist did NOT reply (coordinator handled directly)
    await assertNoMessages({
      client,
      config,
      stream: config.stream,
      topic,
      predicate: (msg) =>
        isFromBot(msg, config) &&
        !isFrom(msg, config.coordinatorEmail),
      label: "specialist reply (should not exist for cross-dept question)",
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
