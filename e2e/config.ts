/**
 * E2E test configuration.
 * All real names/credentials come from environment variables.
 * Loads .env.e2e from project root if present.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load key=value pairs from a dotenv-style file into process.env. */
function loadEnvFile(filePath: string): void {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return; // file not found — silently skip
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Load .env.e2e from project root (one level up from e2e/)
loadEnvFile(resolve(__dirname, "..", ".env.e2e"));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value.trim();
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export type E2EConfig = {
  /** Zulip instance base URL */
  zulipUrl: string;
  /** Sim-user email (acts as the human in scenarios) */
  simUserEmail: string;
  /** Sim-user API key */
  simUserApiKey: string;
  /** Stream to run tests in */
  stream: string;
  /** Coordinator bot display name (for @mentions) */
  coordinatorDisplayName: string;
  /** Coordinator bot email (for identifying responses) */
  coordinatorEmail: string;
  /** Specialist bot display name (for @mentions) */
  specialistDisplayName: string;
  /** Specialist bot email (for identifying responses) */
  specialistEmail: string;
  /** All bot emails (for filtering bot vs human messages) */
  allBotEmails: string[];
  /** Timeout in ms for waiting on expected responses */
  responseTimeoutMs: number;
  /** Timeout in ms for negative assertions (wait to confirm no response) */
  negativeTimeoutMs: number;
  /** Poll interval in ms when waiting for messages/reactions */
  pollIntervalMs: number;
};

export function loadConfig(): E2EConfig {
  const coordinatorEmail = required("E2E_COORDINATOR_EMAIL");
  const specialistEmail = required("E2E_SPECIALIST_EMAIL");

  return {
    zulipUrl: required("E2E_ZULIP_URL"),
    simUserEmail: required("E2E_SIM_USER_EMAIL"),
    simUserApiKey: required("E2E_SIM_USER_API_KEY"),
    stream: optional("E2E_STREAM", "e2e-tests"),
    coordinatorDisplayName: required("E2E_COORDINATOR_DISPLAY_NAME"),
    coordinatorEmail,
    specialistDisplayName: required("E2E_SPECIALIST_DISPLAY_NAME"),
    specialistEmail,
    allBotEmails: [coordinatorEmail, specialistEmail],
    responseTimeoutMs: Number(optional("E2E_RESPONSE_TIMEOUT_MS", "30000")),
    negativeTimeoutMs: Number(optional("E2E_NEGATIVE_TIMEOUT_MS", "15000")),
    pollIntervalMs: Number(optional("E2E_POLL_INTERVAL_MS", "2000")),
  };
}
