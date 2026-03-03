import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (id: string) => id || "default",
  createReplyPrefixOptions: vi.fn(() => ({ onModelSelected: vi.fn() })),
}));

vi.mock("./monitor-reaction-context.js", () => ({
  dispatchSyntheticReactionContext: vi.fn(),
}));

vi.mock("./normalize.js", () => ({
  normalizeEmojiName: vi.fn((name: string) => name?.replace(/^:|:$/g, "").trim() || ""),
}));

vi.mock("./reaction-buttons.js", () => ({
  handleReactionEvent: vi.fn(() => null),
  getReactionButtonSession: vi.fn(() => undefined),
}));

vi.mock("./topic-rename.js", () => ({
  resolveCanonicalTopicSessionKey: vi.fn(() => "general%20chat"),
}));

import type { MonitorContext, ZulipReactionEvent } from "./monitor-types.js";
import type { ReactionMessageContextTracker } from "./monitor-reaction-context.js";
import { handleReaction } from "./monitor-handle-reaction.js";
import { handleReactionEvent, getReactionButtonSession } from "./reaction-buttons.js";
import { dispatchSyntheticReactionContext } from "./monitor-reaction-context.js";

function makeReactionEvent(overrides?: Partial<ZulipReactionEvent>): ZulipReactionEvent {
  return {
    type: "reaction",
    op: "add",
    message_id: 42,
    emoji_name: "thumbs_up",
    emoji_code: "1f44d",
    user_id: 200,
    user: { full_name: "Human User", user_id: 200 },
    ...overrides,
  };
}

function makeMctx(): MonitorContext {
  return {
    account: {
      accountId: "default",
      enabled: true,
      baseUrl: "https://zulip.example",
      email: "bot@example.com",
      apiKey: "key",
      baseUrlSource: "config" as const,
      emailSource: "config" as const,
      apiKeySource: "config" as const,
      streams: ["marcel-ai"],
      alwaysReply: true,
      defaultTopic: "general chat",
      reactions: {
        enabled: true,
        onStart: "eyes",
        onSuccess: "check_mark",
        onFailure: "warning",
        clearOnFinish: true,
        workflow: {
          enabled: true,
          replaceStageReaction: true,
          minTransitionMs: 1500,
          stages: {
            queued: "eyes",
            processing: "eyes",
            success: "check_mark",
            partialSuccess: "warning",
            failure: "warning",
          },
        },
        genericCallback: {
          enabled: true,
          includeRemoveOps: false,
          allowedEmojis: ["thumbs_up", "+1", "cross_mark"],
          emojiSemantics: { thumbs_up: "approve" },
        },
      },
      textChunkLimit: 10_000,
      config: {},
    },
    auth: { baseUrl: "https://zulip.example", email: "bot@example.com", apiKey: "key" },
    cfg: { channels: { zulip: { enabled: true } } },
    core: {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "agent-1",
            sessionKey: "zulip:default",
            accountId: "default",
          })),
        },
        activity: { record: vi.fn() },
      },
    } as unknown as MonitorContext["core"],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: { error: vi.fn() } as unknown as MonitorContext["runtime"],
    opts: {},
    abortSignal: new AbortController().signal,
    botUserId: 100,
    dedupe: { check: vi.fn(() => false) },
    dmNotifiedSenders: new Set<number>(),
    topicAliasesByStream: new Map(),
    mentionDisplayNames: new Map(),
    siblingBotUserIds: new Set<number>(),
    stopped: () => false,
  };
}

function makeTracker(): ReactionMessageContextTracker {
  return {
    remember: vi.fn(),
    resolve: vi.fn(async () => ({
      stream: "marcel-ai",
      topic: "general chat",
      streamId: 5,
      senderId: 100, // bot's own message
    })),
    toCommandToken: vi.fn((name: string) => name.replace(/[^a-z0-9_+-]+/gi, "_").toLowerCase()),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(handleReactionEvent).mockReturnValue(null);
  vi.mocked(getReactionButtonSession).mockReturnValue(undefined);
});

// spec: reactions.md ## Reaction Handling Entry
describe("handleReaction — early exits", () => {
  it("returns when message_id is not a number", async () => {
    const mctx = makeMctx();
    const tracker = makeTracker();
    await handleReaction(mctx, makeReactionEvent({ message_id: undefined as unknown as number }), tracker);
    expect(handleReactionEvent).not.toHaveBeenCalled();
  });

  it("returns when genericCallback is disabled and no button match", async () => {
    const mctx = makeMctx();
    mctx.account.reactions.genericCallback.enabled = false;
    const tracker = makeTracker();
    await handleReaction(mctx, makeReactionEvent(), tracker);
    expect(dispatchSyntheticReactionContext).not.toHaveBeenCalled();
  });

  it("ignores bot's own reactions", async () => {
    const mctx = makeMctx();
    const tracker = makeTracker();
    await handleReaction(mctx, makeReactionEvent({ user_id: 100 }), tracker);
    expect(dispatchSyntheticReactionContext).not.toHaveBeenCalled();
  });

  it("ignores sibling bot reactions", async () => {
    const mctx = makeMctx();
    mctx.siblingBotUserIds.add(300);
    const tracker = makeTracker();
    await handleReaction(mctx, makeReactionEvent({ user_id: 300 }), tracker);
    expect(dispatchSyntheticReactionContext).not.toHaveBeenCalled();
  });

  it("ignores remove ops when includeRemoveOps is false", async () => {
    const mctx = makeMctx();
    const tracker = makeTracker();
    await handleReaction(mctx, makeReactionEvent({ op: "remove" }), tracker);
    expect(dispatchSyntheticReactionContext).not.toHaveBeenCalled();
  });

  it("allows remove ops when includeRemoveOps is true", async () => {
    const mctx = makeMctx();
    mctx.account.reactions.genericCallback.includeRemoveOps = true;
    const tracker = makeTracker();
    await handleReaction(mctx, makeReactionEvent({ op: "remove" }), tracker);
    expect(dispatchSyntheticReactionContext).toHaveBeenCalled();
  });
});

// spec: reactions.md ## Emoji Allowlist
describe("handleReaction — emoji allowlist", () => {
  it("ignores emojis not in the allowlist", async () => {
    const mctx = makeMctx();
    const tracker = makeTracker();
    await handleReaction(mctx, makeReactionEvent({ emoji_name: "fire" }), tracker);
    expect(dispatchSyntheticReactionContext).not.toHaveBeenCalled();
  });

  it("processes emojis in the allowlist", async () => {
    const mctx = makeMctx();
    const tracker = makeTracker();
    await handleReaction(mctx, makeReactionEvent({ emoji_name: "thumbs_up" }), tracker);
    expect(dispatchSyntheticReactionContext).toHaveBeenCalled();
  });
});

// spec: reactions.md ## Source Resolution
describe("handleReaction — source resolution", () => {
  it("returns when source cannot be resolved", async () => {
    const mctx = makeMctx();
    const tracker = makeTracker();
    vi.mocked(tracker.resolve).mockResolvedValue(null);
    await handleReaction(mctx, makeReactionEvent(), tracker);
    expect(dispatchSyntheticReactionContext).not.toHaveBeenCalled();
  });

  it("returns when source is missing stream", async () => {
    const mctx = makeMctx();
    const tracker = makeTracker();
    vi.mocked(tracker.resolve).mockResolvedValue({ stream: "", topic: "t", senderId: 100 });
    await handleReaction(mctx, makeReactionEvent(), tracker);
    expect(dispatchSyntheticReactionContext).not.toHaveBeenCalled();
  });

  it("only handles reactions on messages sent by this bot", async () => {
    const mctx = makeMctx();
    const tracker = makeTracker();
    vi.mocked(tracker.resolve).mockResolvedValue({
      stream: "marcel-ai",
      topic: "general chat",
      senderId: 999, // Not the bot
    });
    await handleReaction(mctx, makeReactionEvent(), tracker);
    expect(dispatchSyntheticReactionContext).not.toHaveBeenCalled();
  });

  it("skips reactions in streams not in the allowlist", async () => {
    const mctx = makeMctx();
    const tracker = makeTracker();
    vi.mocked(tracker.resolve).mockResolvedValue({
      stream: "off-topic",
      topic: "general chat",
      senderId: 100,
    });
    await handleReaction(mctx, makeReactionEvent(), tracker);
    expect(dispatchSyntheticReactionContext).not.toHaveBeenCalled();
  });

  it("allows any stream when streams list is empty", async () => {
    const mctx = makeMctx();
    mctx.account.streams = [];
    const tracker = makeTracker();
    await handleReaction(mctx, makeReactionEvent(), tracker);
    expect(dispatchSyntheticReactionContext).toHaveBeenCalled();
  });
});

// spec: reactions.md ## Generic Reaction Dispatch
describe("handleReaction — generic callback dispatch", () => {
  it("records activity and dispatches synthetic context", async () => {
    const mctx = makeMctx();
    const tracker = makeTracker();
    const core = mctx.core as unknown as { channel: { activity: { record: ReturnType<typeof vi.fn> } } };
    await handleReaction(mctx, makeReactionEvent(), tracker);

    expect(core.channel.activity.record).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "zulip",
        accountId: "default",
        direction: "inbound",
      }),
    );
    expect(dispatchSyntheticReactionContext).toHaveBeenCalledWith(
      mctx,
      expect.objectContaining({
        stream: "marcel-ai",
        topic: "general chat",
      }),
    );
  });

  it("includes emoji semantics in the system prompt", async () => {
    const mctx = makeMctx();
    const tracker = makeTracker();
    await handleReaction(mctx, makeReactionEvent(), tracker);
    const callArgs = vi.mocked(dispatchSyntheticReactionContext).mock.calls[0]?.[1];
    expect(callArgs?.systemPrompt).toContain(":thumbs_up:");
    expect(callArgs?.systemPrompt).toContain("approve");
  });
});

// spec: reactions.md ## Reaction Buttons
describe("handleReaction — reaction button handling", () => {
  it("dispatches button click when handleReactionEvent returns a result", async () => {
    vi.mocked(handleReactionEvent).mockReturnValue({
      messageId: 42,
      selectedIndex: 0,
      selectedOption: { label: "Yes", value: "yes" },
    });
    vi.mocked(getReactionButtonSession).mockReturnValue({
      messageId: 42,
      stream: "marcel-ai",
      topic: "general chat",
      options: [{ label: "Yes", value: "yes" }],
      createdAt: Date.now(),
      timeoutMs: 300_000,
    });
    const mctx = makeMctx();
    const tracker = makeTracker();
    const core = mctx.core as unknown as { channel: { activity: { record: ReturnType<typeof vi.fn> } } };

    await handleReaction(mctx, makeReactionEvent({ emoji_name: "one" }), tracker);

    expect(core.channel.activity.record).toHaveBeenCalled();
    expect(dispatchSyntheticReactionContext).toHaveBeenCalledWith(
      mctx,
      expect.objectContaining({
        stream: "marcel-ai",
        topic: "general chat",
        errorLabel: "reaction button",
      }),
    );
  });

  it("falls back to tracker when no button session exists", async () => {
    vi.mocked(handleReactionEvent).mockReturnValue({
      messageId: 42,
      selectedIndex: 0,
      selectedOption: { label: "Yes", value: "yes" },
    });
    vi.mocked(getReactionButtonSession).mockReturnValue(undefined);
    const mctx = makeMctx();
    const tracker = makeTracker();
    vi.mocked(tracker.resolve).mockResolvedValue({
      stream: "marcel-ai",
      topic: "general chat",
    });

    await handleReaction(mctx, makeReactionEvent({ emoji_name: "one" }), tracker);

    expect(tracker.resolve).toHaveBeenCalled();
    expect(dispatchSyntheticReactionContext).toHaveBeenCalled();
  });

  it("skips button dispatch when source is unresolvable", async () => {
    vi.mocked(handleReactionEvent).mockReturnValue({
      messageId: 42,
      selectedIndex: 0,
      selectedOption: { label: "Yes", value: "yes" },
    });
    vi.mocked(getReactionButtonSession).mockReturnValue(undefined);
    const mctx = makeMctx();
    const tracker = makeTracker();
    vi.mocked(tracker.resolve).mockResolvedValue(null);

    await handleReaction(mctx, makeReactionEvent({ emoji_name: "one" }), tracker);

    expect(dispatchSyntheticReactionContext).not.toHaveBeenCalled();
  });

  it("only checks buttons on add operations", async () => {
    const mctx = makeMctx();
    mctx.account.reactions.genericCallback.includeRemoveOps = true;
    const tracker = makeTracker();
    await handleReaction(mctx, makeReactionEvent({ op: "remove" }), tracker);

    // handleReactionEvent should NOT be called for "remove" ops
    expect(handleReactionEvent).not.toHaveBeenCalled();
    // But generic callback still processes (since includeRemoveOps=true)
    expect(dispatchSyntheticReactionContext).toHaveBeenCalled();
  });
});
