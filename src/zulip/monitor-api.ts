import { getZulipRuntime } from "../runtime.js";
import type { ZulipAuth } from "./client.js";
import { zulipRequest } from "./client.js";
import { POLL_TIMEOUT_MS } from "./constants.js";
import type {
  ZulipEventsResponse,
  ZulipMeResponse,
  ZulipRegisterResponse,
} from "./monitor-types.js";
import { buildZulipRegisterNarrow } from "./queue-plan.js";
import type { ResolvedZulipAccount } from "./accounts.js";

export function buildAuth(account: ResolvedZulipAccount): ZulipAuth {
  if (!account.baseUrl || !account.email || !account.apiKey) {
    throw new Error("Missing zulip baseUrl/email/apiKey");
  }
  return {
    baseUrl: account.baseUrl,
    email: account.email,
    apiKey: account.apiKey,
  };
}

export async function fetchZulipMe(auth: ZulipAuth, abortSignal?: AbortSignal): Promise<ZulipMeResponse> {
  return await zulipRequest<ZulipMeResponse>({
    auth,
    method: "GET",
    path: "/api/v1/users/me",
    abortSignal,
  });
}

export async function fetchZulipUser(
  auth: ZulipAuth,
  email: string,
  abortSignal?: AbortSignal,
): Promise<{ user_id: number; full_name: string; email: string } | null> {
  try {
    const res = await zulipRequest<{
      result: string;
      user: { user_id: number; full_name: string; email: string };
    }>({
      auth,
      method: "GET",
      path: `/api/v1/users/${encodeURIComponent(email)}`,
      abortSignal,
    });
    return res.result === "success" ? res.user : null;
  } catch {
    return null;
  }
}

export async function registerQueue(params: {
  auth: ZulipAuth;
  stream: string;
  abortSignal?: AbortSignal;
}): Promise<{ queueId: string; lastEventId: number }> {
  const core = getZulipRuntime();
  const narrow = buildZulipRegisterNarrow(params.stream);
  const res = await zulipRequest<ZulipRegisterResponse>({
    auth: params.auth,
    method: "POST",
    path: "/api/v1/register",
    form: {
      event_types: JSON.stringify(["message", "reaction", "update_message"]),
      apply_markdown: "false",
      narrow,
    },
    abortSignal: params.abortSignal,
  });
  if (res.result !== "success" || !res.queue_id || typeof res.last_event_id !== "number") {
    throw new Error(res.msg || "Failed to register Zulip event queue");
  }
  core.logging
    .getChildLogger({ channel: "zulip" })
    .info(`[zulip] registered queue ${res.queue_id} (narrow=channel:${params.stream})`);
  return { queueId: res.queue_id, lastEventId: res.last_event_id };
}

export async function pollEvents(params: {
  auth: ZulipAuth;
  queueId: string;
  lastEventId: number;
  abortSignal?: AbortSignal;
}): Promise<ZulipEventsResponse> {
  // Wrap the parent signal with a per-poll timeout so we don't hang forever
  // if the Zulip server goes unresponsive during long-poll.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onTimeout = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  timer = setTimeout(onTimeout, POLL_TIMEOUT_MS);

  const onParentAbort = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  params.abortSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    return await zulipRequest<ZulipEventsResponse>({
      auth: params.auth,
      method: "GET",
      path: "/api/v1/events",
      query: {
        queue_id: params.queueId,
        last_event_id: params.lastEventId,
        // Be explicit: we want long-poll behavior to avoid tight polling loops that can trigger 429s.
        dont_block: false,
      },
      abortSignal: controller.signal,
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    params.abortSignal?.removeEventListener("abort", onParentAbort);
  }
}
