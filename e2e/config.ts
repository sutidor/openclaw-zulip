/**
 * E2E test configuration for the Zulip plugin.
 * All real names/credentials come from environment variables.
 * Loads .env.e2e from project root if present.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type BaseE2EConfig, loadEnvFile, required, optional } from "@openclaw/e2e";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.e2e from project root (one level up from e2e/)
loadEnvFile(resolve(__dirname, "..", ".env.e2e"));

export type E2EConfig = BaseE2EConfig & {
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
