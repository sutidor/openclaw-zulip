/**
 * Scenario R11: PA agent attaches to Brave browser via extension relay.
 *
 * Parties: sim-user, specialist (PA bot)
 *
 * Precondition: The Chrome extension relay must be active in Sven's Brave
 * browser with at least one tab open. If no extension is connected, the
 * PA should report that gracefully (not claim browser access is blocked).
 *
 * Success criterion: user @mentions the PA and asks it to attach to the
 * brave browser. The PA lists available tabs and reports what it finds.
 * It does NOT refuse or claim browser access is unavailable.
 *
 * Expected behavior:
 * - PA: receives the @mention, calls browser({ action: "tabs",
 *   profile: "brave" }), and reports the available tabs or explains
 *   that the extension isn't connected (without claiming browser
 *   access is blocked entirely).
 */

import type { E2EConfig } from "../config.js";
import {
  type ZulipClient,
  type ScenarioResult,
  uniqueTopic,
  waitForMessages,
  sleep,
  isFrom,
} from "@openclaw/e2e";

/** Phrases that indicate the agent wrongly refused browser access entirely */
const REFUSAL_PATTERNS = [
  /don't have browser/i,
  /no browser/i,
  /browser.*not available/i,
  /browser.*blocked/i,
  /can't.*browse/i,
  /cannot.*browse/i,
  /unable to.*brows/i,
  /don't have.*automation/i,
];

/**
 * Phrases that indicate the PA correctly attempted the brave profile
 * (whether tabs were found or the extension wasn't connected)
 */
const ATTEMPT_PATTERNS = [
  /tab/i,              // mentions tabs (listing them or saying none found)
  /brave/i,            // mentions the brave profile
  /extension/i,        // mentions the extension (connected or not)
  /no.*connect/i,      // reports extension not connected
  /not.*connect/i,     // reports extension not connected
  /relay/i,            // mentions the relay
];

export async function run(
  client: ZulipClient,
  config: E2EConfig,
): Promise<ScenarioResult> {
  const name = "R11-pa-browser-brave";
  const start = Date.now();

  try {
    const topic = uniqueTopic("r11");
    const mention = `@**${config.specialistDisplayName}**`;

    // Ask the PA to attach to the brave browser and list tabs
    await client.sendMessage(
      config.stream,
      topic,
      `${mention} Attach to my Brave browser using the brave profile. ` +
        `List the open tabs. Use browser({ action: "tabs", profile: "brave" }).`,
    );

    // Wait for PA reply
    const browserTimeoutMs = Math.max(config.responseTimeoutMs, 60_000);
    let replies;

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        replies = await waitForMessages({
          client,
          config: { ...config, responseTimeoutMs: browserTimeoutMs },
          stream: config.stream,
          topic,
          predicate: (msg) => isFrom(msg, config.specialistEmail),
          label: `PA brave browser reply (attempt ${attempt})`,
        });
        break;
      } catch {
        if (attempt === maxAttempts) {
          throw new Error(
            `PA did not reply after ${maxAttempts} attempts (timeout: ${browserTimeoutMs}ms)`,
          );
        }
        await sleep(config.pollIntervalMs);
      }
    }

    const replyContent = replies![0].content;

    // Check for blanket refusal — the PA must NOT claim it lacks browser access
    for (const pattern of REFUSAL_PATTERNS) {
      if (pattern.test(replyContent)) {
        return {
          name,
          passed: false,
          error:
            `PA refused browser access entirely. Matched: ${pattern}. ` +
            `Reply: ${replyContent.slice(0, 300)}`,
          durationMs: Date.now() - start,
        };
      }
    }

    // Check that the PA actually attempted to use the brave profile
    const attempted = ATTEMPT_PATTERNS.some((p) => p.test(replyContent));
    if (!attempted) {
      return {
        name,
        passed: false,
        error:
          `PA replied but didn't appear to attempt the brave browser profile. ` +
          `Expected mention of tabs, brave, extension, or relay. ` +
          `Reply: ${replyContent.slice(0, 300)}`,
        durationMs: Date.now() - start,
      };
    }

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
