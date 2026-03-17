/** Timeout for long-poll requests to /api/v1/events. Must exceed Zulip's server-side timeout (~90s). */
export const POLL_TIMEOUT_MS = 120_000;

/** Grace period for in-flight deliveries to finish after monitor abort. */
export const DELIVERY_GRACE_MS = 10_000;

/** Hard timeout per message handler delivery cycle. */
export const DELIVERY_TIMEOUT_MS = 1_200_000;

/** Max concurrent message handlers per stream queue (backpressure). */
export const MAX_CONCURRENT_HANDLERS = 20;

/** Interval for freshness checker that catches missed messages. */
export const FRESHNESS_INTERVAL_MS = 30_000;

/** Default timeout waiting for dispatcher to flush queued replies. */
export const DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

/** Delay before first keepalive ping (reaction-based, no visible message). */
export const KEEPALIVE_INITIAL_DELAY_MS = 60_000;

/** Interval between subsequent keepalive pings. */
export const KEEPALIVE_REPEAT_INTERVAL_MS = 90_000;

/** Message posted to Zulip when replaying a recovery checkpoint. */
export const ZULIP_RECOVERY_NOTICE = "🔄 Gateway restarted - resuming the previous task now...";

/** Maximum age of a message (in ms) before it is considered stale and skipped. */
export const MAX_MESSAGE_AGE_MS = 10 * 60_000;

/** Regex matching NO_REPLY sentinel values emitted by the LLM to suppress delivery. */
export const NO_REPLY_PATTERN = /^(\[?\s*NO[-_\s]?REPLY\s*\]?)$/i;
