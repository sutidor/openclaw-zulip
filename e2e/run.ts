#!/usr/bin/env npx tsx
/**
 * E2E test runner for PRD 001 — Multi-Bot Collaboration.
 *
 * Runs all scenarios against a live Zulip instance and reports results.
 * Requires environment variables for credentials (see e2e/config.ts).
 *
 * Usage:
 *   npx tsx e2e/run.ts              # run all scenarios
 *   npx tsx e2e/run.ts r1 r4 r6     # run specific scenarios
 */

import { loadConfig } from "./config.js";
import { createZulipClient } from "./zulip-client.js";
import { sleep } from "./helpers.js";
import type { ScenarioResult } from "./helpers.js";

import { run as r1 } from "./scenarios/r1-coordinator.js";
import { run as r2 } from "./scenarios/r2-mention-only.js";
import { run as r3 } from "./scenarios/r3-reactions.js";
import { run as r4 } from "./scenarios/r4-trivial.js";
import { run as r5 } from "./scenarios/r5-invocation.js";
import { run as r6 } from "./scenarios/r6-silent.js";
import { run as r7 } from "./scenarios/r7-bot-reactions.js";
import { run as r8 } from "./scenarios/r8-targeting.js";

// Ordered: deterministic routing tests first (fast, gateway fresh),
// then LLM-dependent tests last (slower, benefit from cooldown gaps).
const ALL_SCENARIOS: Record<
  string,
  (
    client: ReturnType<typeof createZulipClient>,
    config: ReturnType<typeof loadConfig>,
  ) => Promise<ScenarioResult>
> = {
  r1,
  r2,
  r6,
  r8,
  r7,
  r4,
  r3,
  r5,
};

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createZulipClient({
    baseUrl: config.zulipUrl,
    email: config.simUserEmail,
    apiKey: config.simUserApiKey,
  });

  // Verify sim-user connectivity
  const me = await client.getMe();
  console.log(`Sim-user: ${me.full_name} (${me.email})`);
  console.log(`Stream: ${config.stream}`);
  console.log(`Coordinator: ${config.coordinatorDisplayName} (${config.coordinatorEmail})`);
  console.log(`Specialist: ${config.specialistDisplayName} (${config.specialistEmail})`);
  console.log("");

  // Determine which scenarios to run
  const args = process.argv.slice(2).map((a) => a.toLowerCase());
  const scenarioKeys =
    args.length > 0
      ? args.filter((a) => a in ALL_SCENARIOS)
      : Object.keys(ALL_SCENARIOS);

  if (scenarioKeys.length === 0) {
    console.error("No valid scenarios specified. Available:", Object.keys(ALL_SCENARIOS).join(", "));
    process.exit(1);
  }

  // Cooldown between scenarios prevents the gateway from OOM-ing.
  // Each scenario spawns up to 3 LLM agent sessions (one per bot monitor).
  // Without cooldown, lingering sessions from a timed-out scenario pile up
  // with sessions from the next scenario, exhausting memory.
  const cooldownMs = Number(process.env.E2E_SCENARIO_COOLDOWN_MS ?? "10000");

  console.log(`Running ${scenarioKeys.length} scenario(s): ${scenarioKeys.join(", ")}`);
  console.log(`Cooldown between scenarios: ${(cooldownMs / 1_000).toFixed(0)}s\n`);

  const results: ScenarioResult[] = [];

  for (let i = 0; i < scenarioKeys.length; i++) {
    const key = scenarioKeys[i];
    const scenario = ALL_SCENARIOS[key];
    console.log(`--- ${key} ---`);
    const result = await scenario(client, config);
    results.push(result);

    const status = result.passed ? "PASS" : "FAIL";
    const duration = (result.durationMs / 1_000).toFixed(1);
    console.log(`  ${status} (${duration}s)${result.error ? ` — ${result.error}` : ""}`);

    // Cooldown: let the gateway drain agent sessions before next scenario.
    if (i < scenarioKeys.length - 1 && cooldownMs > 0) {
      console.log(`  (cooldown ${(cooldownMs / 1_000).toFixed(0)}s)\n`);
      await sleep(cooldownMs);
    } else {
      console.log("");
    }
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log("=".repeat(50));
  console.log(
    `Results: ${passed} passed, ${failed} failed, ${results.length} total (${(totalMs / 1_000).toFixed(1)}s)`,
  );

  if (failed > 0) {
    console.log("\nFailed scenarios:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
