import {
  KEEPALIVE_INITIAL_DELAY_MS,
  KEEPALIVE_REPEAT_INTERVAL_MS,
} from "./constants.js";

function formatKeepaliveElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${totalSeconds}s`;
  }
  if (seconds <= 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

export function buildKeepaliveMessageContent(elapsedMs: number): string {
  return `🔧 Still working... (${formatKeepaliveElapsed(elapsedMs)} elapsed)`;
}

export function startPeriodicKeepalive(params: {
  sendPing: (elapsedMs: number) => Promise<void>;
  initialDelayMs?: number;
  repeatIntervalMs?: number;
  now?: () => number;
}): () => void {
  const initialDelayMs = params.initialDelayMs ?? KEEPALIVE_INITIAL_DELAY_MS;
  const repeatIntervalMs = params.repeatIntervalMs ?? KEEPALIVE_REPEAT_INTERVAL_MS;
  const now = params.now ?? (() => Date.now());

  const startedAt = now();
  let stopped = false;
  let repeatTimer: ReturnType<typeof setInterval> | undefined;

  const firePing = () => {
    if (stopped) {
      return;
    }
    void params.sendPing(Math.max(0, now() - startedAt)).catch(() => undefined);
  };

  const initialTimer = setTimeout(() => {
    firePing();
    if (stopped) {
      return;
    }
    repeatTimer = setInterval(() => {
      firePing();
    }, repeatIntervalMs);
    repeatTimer.unref?.();
  }, initialDelayMs);

  initialTimer.unref?.();

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(initialTimer);
    if (repeatTimer) {
      clearInterval(repeatTimer);
    }
  };
}

export function createBestEffortShutdownNoticeSender(params: {
  sendNotice: () => Promise<void>;
  log?: (message: string) => void;
}): () => void {
  let sent = false;
  return () => {
    if (sent) {
      return;
    }
    sent = true;
    void params.sendNotice().catch((err) => {
      params.log?.(`[zulip] shutdown notice failed: ${String(err)}`);
    });
  };
}
