import type { OpenClawConfig, PluginRuntime, ReplyPayload, RuntimeEnv } from "openclaw/plugin-sdk";
import type { ResolvedZulipAccount } from "./accounts.js";
import type { ZulipAuth } from "./client.js";
import type { DedupeCache } from "./dedupe.js";

// ---------------------------------------------------------------------------
// MonitorContext — shared state threaded through all monitor sub-modules
// ---------------------------------------------------------------------------

export type MonitorContext = {
  account: ResolvedZulipAccount;
  auth: ZulipAuth;
  cfg: OpenClawConfig;
  core: PluginRuntime;
  logger: MonitorLogger;
  runtime: RuntimeEnv;
  opts: MonitorZulipOptions;
  abortSignal: AbortSignal;
  botUserId: number;
  dedupe: DedupeCache;
  dmNotifiedSenders: Set<number>;
  topicAliasesByStream: Map<string, Map<string, string>>;
  /** Maps email prefix (e.g. "amira-bot") → Zulip display name (e.g. "📐 Amira")
   *  for all known Zulip accounts. Used to normalize outgoing @mentions. */
  mentionDisplayNames: Map<string, string>;
  /** Zulip user IDs of sibling bot accounts. Used to filter out
   *  bot-to-bot reactions in the generic reaction callback. */
  siblingBotUserIds: Set<number>;
  stopped: () => boolean;
};

export type MonitorLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
};

// ---------------------------------------------------------------------------
// Options for monitorZulipProvider
// ---------------------------------------------------------------------------

export type MonitorZulipOptions = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastEventAt?: number;
    lastError?: string;
  }) => void;
};

// ---------------------------------------------------------------------------
// Zulip API response / event types
// ---------------------------------------------------------------------------

export type ZulipRegisterResponse = {
  result: "success" | "error";
  msg?: string;
  queue_id?: string;
  last_event_id?: number;
};

export type ZulipEventMessage = {
  id: number;
  type: string;
  sender_id: number;
  sender_full_name?: string;
  sender_email?: string;
  display_recipient?: string;
  stream_id?: number;
  subject?: string;
  content?: string;
  content_type?: string;
  timestamp?: number;
};

export type ZulipReactionEvent = {
  id?: number;
  type: "reaction";
  op: "add" | "remove";
  message_id: number;
  emoji_name: string;
  emoji_code: string;
  user_id: number;
  user?: {
    email?: string;
    full_name?: string;
    user_id?: number;
  };
  message?: ZulipEventMessage;
};

export type ZulipEvent = {
  id?: number;
  type?: string;
  message?: ZulipEventMessage;
  subject?: string;
  orig_subject?: string;
  topic?: string;
  orig_topic?: string;
} & Partial<ZulipReactionEvent>;

export type ZulipEventsResponse = {
  result: "success" | "error";
  msg?: string;
  events?: ZulipEvent[];
  last_event_id?: number;
};

export type ZulipMeResponse = {
  result: "success" | "error";
  msg?: string;
  user_id?: number;
  email?: string;
  full_name?: string;
};
