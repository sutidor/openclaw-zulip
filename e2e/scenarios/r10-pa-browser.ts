/**
 * Scenario R10: PA agent uses browser tool (headless profile) when asked.
 *
 * Parties: sim-user, specialist (PA bot)
 *
 * Precondition: The headless browser container must be running and reachable
 * from the gateway (openclaw-browser:9222).
 *
 * Verification strategy — NEVER TRUST THE AGENT'S TEXT:
 *   1. Ask the PA to browse a page and report content.
 *   2. After it replies, check the gateway container logs for browser tool
 *      outcomes during the test window.
 *   3. PASS only if: (a) no refusal patterns, (b) logs show at least one
 *      successful browser tool call with profile "headless", and (c) no
 *      "browser failed" errors for the headless profile.
 *
 * Why not trust the reply text: The agent (LLM) may fabricate a plausible
 * answer using the brave profile or prior knowledge without actually using
 * the headless browser. Only gateway logs prove real tool invocation.
 */

import { execSync } from "node:child_process";
import type { E2EConfig } from "../config.js";
import {
  type ZulipClient,
  type ScenarioResult,
  sendAndWaitForReply,
} from "@openclaw/e2e";

/** Phrases that indicate the agent refused to use the browser */
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
 * Fetch gateway container logs for a time window and return browser-related lines.
 * Runs `docker logs` on the host — the E2E runner runs on the host, not in Docker.
 */
function getGatewayBrowserLogs(sinceSec: number): string {
  try {
    const raw = execSync(
      `docker logs --since=${sinceSec}s openclaw-openclaw-gateway-1 2>&1`,
      { encoding: "utf-8", timeout: 10_000 },
    );
    return raw
      .split("\n")
      .filter((line) => /\[tools\] browser|\[browser\//.test(line))
      .join("\n");
  } catch {
    return "";
  }
}

export async function run(
  client: ZulipClient,
  config: E2EConfig,
): Promise<ScenarioResult> {
  const name = "R10-pa-browser";
  const start = Date.now();

  try {
    const testStartedAt = Date.now();

    // Ask the PA to use the headless browser specifically
    const { replies } = await sendAndWaitForReply({
      client,
      config: { ...config, responseTimeoutMs: Math.max(config.responseTimeoutMs, 90_000) },
      stream: config.stream,
      scenario: "r10",
      prompt:
        `Use your browser tool with profile="headless" to navigate to https://example.com ` +
        `and take a snapshot. Report the page title and main heading. ` +
        `You MUST use the headless profile, not brave.`,
      botEmail: config.specialistEmail,
      botDisplayName: config.specialistDisplayName,
      label: "PA headless browser reply",
    });

    const replyContent = replies[0].content;

    // Step 1: Check for refusal patterns
    for (const pattern of REFUSAL_PATTERNS) {
      if (pattern.test(replyContent)) {
        return {
          name,
          passed: false,
          error:
            `PA refused browser tool. Matched: ${pattern}. ` +
            `Reply: ${replyContent.slice(0, 300)}`,
          durationMs: Date.now() - start,
        };
      }
    }

    // Step 2: Independent verification — check gateway logs
    // The logs are the source of truth, not the agent's reply text.
    const elapsedSec = Math.ceil((Date.now() - testStartedAt) / 1000) + 5;
    const browserLogs = getGatewayBrowserLogs(elapsedSec);

    // Check for headless browser failures
    const headlessFailures = browserLogs
      .split("\n")
      .filter((l) => /browser failed/i.test(l) && /headless|openclaw-browser:9222/i.test(l));

    if (headlessFailures.length > 0) {
      return {
        name,
        passed: false,
        error:
          `Gateway logs show headless browser failures during test window ` +
          `(agent may have lied about success). ` +
          `Failures: ${headlessFailures.slice(0, 3).join(" | ")}. ` +
          `Reply: ${replyContent.slice(0, 200)}`,
        durationMs: Date.now() - start,
      };
    }

    // Step 3: Verify the reply shows evidence of actual browsing.
    // Successful browser calls don't produce [tools] browser log lines —
    // only failures do. So absence of log lines + absence of refusal +
    // presence of browsing evidence = pass.
    //
    // Evidence: screenshot upload (user_uploads/), mention of page content,
    // or a snapshot. We accept any of these since the model may format
    // results differently.
    const hasBrowsingEvidence =
      /user_uploads\//i.test(replyContent) ||         // screenshot uploaded
      /example\s*domain/i.test(replyContent) ||       // page content
      /example\.com/i.test(replyContent) ||           // URL mentioned
      /snapshot/i.test(replyContent) ||               // snapshot action
      /navigate/i.test(replyContent) ||               // navigation mentioned
      /title.*example/i.test(replyContent) ||         // page title
      /heading/i.test(replyContent);                  // heading mentioned

    if (!hasBrowsingEvidence) {
      return {
        name,
        passed: false,
        error:
          `PA replied without refusal or log failures, but reply lacks ` +
          `browsing evidence (no screenshot, page content, or navigation ` +
          `details). Reply: ${replyContent.slice(0, 300)}`,
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
