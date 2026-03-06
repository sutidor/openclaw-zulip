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
import {
  createZulipClient,
  parseScenarioArgs,
  runScenarios,
  printSummary,
} from "@openclaw/e2e";

import { run as r1 } from "./scenarios/r1-coordinator.js";
import { run as r2 } from "./scenarios/r2-mention-only.js";
import { run as r3 } from "./scenarios/r3-reactions.js";
import { run as r4 } from "./scenarios/r4-trivial.js";
import { run as r5 } from "./scenarios/r5-invocation.js";
import { run as r6 } from "./scenarios/r6-silent.js";
import { run as r7 } from "./scenarios/r7-bot-reactions.js";
import { run as r8 } from "./scenarios/r8-targeting.js";
import { run as r9 } from "./scenarios/r9-graphiti-search.js";
import { run as r10 } from "./scenarios/r10-pa-browser.js";
import { run as r11 } from "./scenarios/r11-pa-browser-brave.js";

// Ordered: deterministic routing tests first (fast, gateway fresh),
// then LLM-dependent tests last (slower, benefit from cooldown gaps).
const ALL_SCENARIOS = {
  r1, r2, r6, r8, r7, r4, r3, r5, r9, r10, r11,
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

  const selectedKeys = parseScenarioArgs(Object.keys(ALL_SCENARIOS));
  if (selectedKeys.length === 0) {
    console.error("No valid scenarios specified. Available:", Object.keys(ALL_SCENARIOS).join(", "));
    process.exit(1);
  }

  const results = await runScenarios(ALL_SCENARIOS, client, config, selectedKeys);
  printSummary(results);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
