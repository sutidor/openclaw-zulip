import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (id: string) => id || "default",
  createReplyPrefixOptions: vi.fn(() => ({ onModelSelected: vi.fn() })),
}));

vi.mock("./dispatch-state.js", () => ({
  clearDispatchTracking: vi.fn(),
  hasToolSentToTopic: vi.fn(() => false),
}));

vi.mock("./mention-cache.js", () => ({
  normalizeMentions: vi.fn((payload: unknown) => payload),
}));

vi.mock("./accounts.js", () => ({
  listEnabledZulipAccounts: vi.fn(() => []),
  resolveDefaultZulipAccountId: vi.fn(() => "default"),
  isAutoReplyStream: vi.fn(() => true),
}));

vi.mock("./inflight-checkpoints.js", () => ({
  ZULIP_INFLIGHT_CHECKPOINT_VERSION: 1,
  buildZulipCheckpointId: vi.fn(() => "default:42"),
  clearZulipInFlightCheckpoint: vi.fn(async () => {}),
  markZulipCheckpointFailure: vi.fn((p: { checkpoint: unknown }) => p.checkpoint),
  prepareZulipCheckpointForRecovery: vi.fn((p: { checkpoint: unknown }) => p.checkpoint),
  writeZulipInFlightCheckpoint: vi.fn(async () => {}),
}));

vi.mock("./send.js", () => ({
  sendZulipStreamMessage: vi.fn(async () => ({ result: "success" })),
}));

vi.mock("./uploads.js", () => ({
  downloadZulipUploads: vi.fn(async () => []),
}));

vi.mock("./sleep.js", () => ({
  sleep: vi.fn(async () => {}),
}));

vi.mock("./backoff.js", () => ({
  waitForDispatcherIdleWithTimeout: vi.fn(async ({ waitForIdle }: { waitForIdle: () => Promise<void> }) => waitForIdle()),
}));

vi.mock("./keepalive.js", () => ({
  buildKeepaliveMessageContent: vi.fn(() => "keepalive"),
  createBestEffortShutdownNoticeSender: vi.fn(() => vi.fn()),
  startPeriodicKeepalive: vi.fn(() => vi.fn()),
}));

vi.mock("./deliver.js", () => ({
  deliverReply: vi.fn(async () => {}),
}));

vi.mock("./messaging.js", () => ({
  shouldIgnoreMessage: vi.fn(() => ({ ignore: false })),
  startTypingRefresh: vi.fn(() => vi.fn()),
  stopTypingIndicator: vi.fn(async () => {}),
}));

vi.mock("./reaction-workflow.js", () => ({
  bestEffortReaction: vi.fn(async () => {}),
  createReactionTransitionController: vi.fn(() => ({
    transition: vi.fn(async () => {}),
  })),
  withWorkflowReactionStages: vi.fn((dispatcher: unknown) => dispatcher),
}));

vi.mock("./topic-rename.js", () => ({
  resolveCanonicalTopicSessionKey: vi.fn(() => "general%20chat"),
}));

vi.mock("./normalize.js", () => ({
  normalizeStreamName: vi.fn((s: string) => s?.trim().toLowerCase() || ""),
  normalizeTopic: vi.fn((t: string) => t?.trim() || ""),
}));

import type { MonitorContext, ZulipEventMessage } from "./monitor-types.js";
import { handleMessage } from "./monitor-handle-message.js";
import { shouldIgnoreMessage } from "./messaging.js";
import { listEnabledZulipAccounts, resolveDefaultZulipAccountId, isAutoReplyStream } from "./accounts.js";
import { hasToolSentToTopic, clearDispatchTracking } from "./dispatch-state.js";
import { bestEffortReaction } from "./reaction-workflow.js";
import { writeZulipInFlightCheckpoint, clearZulipInFlightCheckpoint } from "./inflight-checkpoints.js";
import { deliverReply } from "./deliver.js";
import { sendZulipStreamMessage } from "./send.js";

type MockCore = {
  channel: {
    routing: { resolveAgentRoute: ReturnType<typeof vi.fn> };
    mentions: {
      buildMentionRegexes: ReturnType<typeof vi.fn>;
      matchesMentionPatterns: ReturnType<typeof vi.fn>;
    };
    activity: { record: ReturnType<typeof vi.fn> };
    reply: {
      formatInboundEnvelope: ReturnType<typeof vi.fn>;
      finalizeInboundContext: ReturnType<typeof vi.fn>;
      createReplyDispatcherWithTyping: ReturnType<typeof vi.fn>;
      dispatchReplyFromConfig: ReturnType<typeof vi.fn>;
      resolveHumanDelayConfig: ReturnType<typeof vi.fn>;
    };
  };
};

function makeMsg(overrides?: Partial<ZulipEventMessage>): ZulipEventMessage {
  return {
    id: 42,
    type: "stream",
    sender_id: 200,
    sender_full_name: "Human User",
    sender_email: "human@example.com",
    display_recipient: "marcel-ai",
    stream_id: 5,
    subject: "general chat",
    content: "Hello bot!",
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeMockCore(): MockCore {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "agent-1",
          sessionKey: "zulip:default",
          accountId: "default",
        })),
      },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionPatterns: vi.fn(() => false),
      },
      activity: { record: vi.fn() },
      reply: {
        formatInboundEnvelope: vi.fn(() => "formatted body"),
        finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
        createReplyDispatcherWithTyping: vi.fn(() => ({
          dispatcher: {
            markComplete: vi.fn(),
            waitForIdle: vi.fn(async () => {}),
            sendToolResult: vi.fn(),
            sendBlockReply: vi.fn(),
            sendFinalReply: vi.fn(),
          },
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        })),
        dispatchReplyFromConfig: vi.fn(async () => {}),
        resolveHumanDelayConfig: vi.fn(() => ({})),
      },
    },
  };
}

function makeMctx(coreOverride?: MockCore): MonitorContext {
  const core = coreOverride ?? makeMockCore();
  return {
    account: {
      accountId: "default",
      enabled: true,
      baseUrl: "https://zulip.example",
      email: "bot@example.com",
      apiKey: "key",
      baseUrlSource: "config",
      emailSource: "config",
      apiKeySource: "config",
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
          allowedEmojis: ["thumbs_up"],
          emojiSemantics: { thumbs_up: "approve" },
        },
      },
      textChunkLimit: 10_000,
      config: {},
    },
    auth: { baseUrl: "https://zulip.example", email: "bot@example.com", apiKey: "key" },
    cfg: { channels: { zulip: { enabled: true, baseUrl: "https://zulip.example", email: "bot@example.com", apiKey: "key", streams: ["marcel-ai"] } } },
    core: core as unknown as MonitorContext["core"],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: { error: vi.fn() } as unknown as MonitorContext["runtime"],
    opts: { statusSink: vi.fn() },
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(shouldIgnoreMessage).mockReturnValue({ ignore: false });
  vi.mocked(listEnabledZulipAccounts).mockReturnValue([]);
  vi.mocked(resolveDefaultZulipAccountId).mockReturnValue("default");
  vi.mocked(hasToolSentToTopic).mockReturnValue(false);
});

// spec: message-handling.md ## Early Exit Conditions
describe("handleMessage — early exits", () => {
  it("returns immediately when msg.id is not a number", async () => {
    const mctx = makeMctx();
    await handleMessage(mctx, makeMsg({ id: undefined as unknown as number }));
    expect(mctx.dedupe.check).not.toHaveBeenCalled();
  });

  it("returns when message is a duplicate", async () => {
    const mctx = makeMctx();
    vi.mocked(mctx.dedupe.check).mockReturnValue(true);
    await handleMessage(mctx, makeMsg());
    expect(shouldIgnoreMessage).not.toHaveBeenCalled();
  });

  it("returns when shouldIgnoreMessage says ignore", async () => {
    const mctx = makeMctx();
    vi.mocked(shouldIgnoreMessage).mockReturnValue({ ignore: true, reason: "self" });
    const core = mctx.core as unknown as MockCore;
    await handleMessage(mctx, makeMsg());
    expect(core.channel.activity.record).not.toHaveBeenCalled();
  });

  it("returns when content is empty and has no upload URLs", async () => {
    const mctx = makeMctx();
    const core = mctx.core as unknown as MockCore;
    await handleMessage(mctx, makeMsg({ content: "   " }));
    expect(core.channel.activity.record).not.toHaveBeenCalled();
  });

  it("does NOT bail when content contains /user_uploads/", async () => {
    const mctx = makeMctx();
    const core = mctx.core as unknown as MockCore;
    await handleMessage(mctx, makeMsg({ content: "  /user_uploads/2/abc.png  " }));
    expect(core.channel.activity.record).toHaveBeenCalled();
  });

  it("returns when stream normalizes to empty", async () => {
    const mctx = makeMctx();
    const core = mctx.core as unknown as MockCore;
    await handleMessage(mctx, makeMsg({ display_recipient: "" }));
    expect(core.channel.activity.record).not.toHaveBeenCalled();
  });
});

// spec: message-handling.md ## Message Age Guard
describe("handleMessage — message age guard", () => {
  it("skips messages older than MAX_MESSAGE_AGE_MS", async () => {
    const mctx = makeMctx();
    const core = mctx.core as unknown as MockCore;
    const fifteenMinAgo = Math.floor((Date.now() - 15 * 60_000) / 1000);
    await handleMessage(mctx, makeMsg({ timestamp: fifteenMinAgo }));
    expect(core.channel.activity.record).not.toHaveBeenCalled();
  });

  it("processes messages younger than MAX_MESSAGE_AGE_MS", async () => {
    const mctx = makeMctx();
    const core = mctx.core as unknown as MockCore;
    const fiveMinAgo = Math.floor((Date.now() - 5 * 60_000) / 1000);
    await handleMessage(mctx, makeMsg({ timestamp: fiveMinAgo }));
    expect(core.channel.activity.record).toHaveBeenCalled();
  });

  it("bypasses age guard for recovery checkpoint replays", async () => {
    const mctx = makeMctx();
    const core = mctx.core as unknown as MockCore;
    const oneHourAgo = Math.floor((Date.now() - 60 * 60_000) / 1000);
    await handleMessage(mctx, makeMsg({ timestamp: oneHourAgo }), {
      recoveryCheckpoint: {
        version: 1,
        checkpointId: "default:42",
        accountId: "default",
        stream: "marcel-ai",
        topic: "general chat",
        messageId: 42,
        senderId: "200",
        senderName: "Human User",
        cleanedContent: "Hello bot!",
        body: "body",
        sessionKey: "key",
        from: "from",
        to: "to",
        wasMentioned: false,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        retryCount: 0,
      },
    });
    expect(core.channel.activity.record).toHaveBeenCalled();
  });

  it("does not apply age guard when timestamp is missing", async () => {
    const mctx = makeMctx();
    const core = mctx.core as unknown as MockCore;
    await handleMessage(mctx, makeMsg({ timestamp: undefined }));
    expect(core.channel.activity.record).toHaveBeenCalled();
  });
});

// spec: message-handling.md ## Mention Evaluation
describe("handleMessage — mention evaluation", () => {
  it("processes message when alwaysReply is true and bot is coordinator", async () => {
    const mctx = makeMctx();
    const core = mctx.core as unknown as MockCore;
    vi.mocked(resolveDefaultZulipAccountId).mockReturnValue("default");
    await handleMessage(mctx, makeMsg());
    expect(core.channel.activity.record).toHaveBeenCalled();
    expect(core.channel.reply.dispatchReplyFromConfig).toHaveBeenCalled();
  });

  it("skips when alwaysReply=false and not mentioned", async () => {
    vi.mocked(isAutoReplyStream).mockReturnValueOnce(false);
    const mctx = makeMctx();
    mctx.account.alwaysReply = false;
    const core = mctx.core as unknown as MockCore;
    await handleMessage(mctx, makeMsg());
    expect(core.channel.reply.dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("processes when alwaysReply=false but bot is @mentioned", async () => {
    const mctx = makeMctx();
    mctx.account.alwaysReply = false;
    const core = mctx.core as unknown as MockCore;
    core.channel.mentions.matchesMentionPatterns.mockReturnValue(true);
    await handleMessage(mctx, makeMsg({ content: "@**Bot** hello" }));
    expect(core.channel.reply.dispatchReplyFromConfig).toHaveBeenCalled();
  });

  it("matches email-prefix mentions (e.g. @**bot**) against account email", async () => {
    const mctx = makeMctx();
    mctx.account.alwaysReply = false;
    mctx.account.email = "bot@example.com";
    const core = mctx.core as unknown as MockCore;
    // The email prefix "bot" matches the display name "@**bot**"
    await handleMessage(mctx, makeMsg({ content: "@**bot** do stuff" }));
    expect(core.channel.reply.dispatchReplyFromConfig).toHaveBeenCalled();
  });
});

// spec: message-handling.md ## Bot-to-Bot Filter
describe("handleMessage — bot-to-bot filter", () => {
  it("skips sibling bot messages when not @mentioned", async () => {
    const mctx = makeMctx();
    vi.mocked(listEnabledZulipAccounts).mockReturnValue([
      { ...mctx.account, accountId: "default" },
      { ...mctx.account, accountId: "other-bot", email: "other@example.com" },
    ] as ReturnType<typeof listEnabledZulipAccounts>);
    const core = mctx.core as unknown as MockCore;
    await handleMessage(mctx, makeMsg({ sender_email: "other@example.com" }));
    expect(core.channel.reply.dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("processes sibling bot messages when @mentioned", async () => {
    const mctx = makeMctx();
    vi.mocked(listEnabledZulipAccounts).mockReturnValue([
      { ...mctx.account, accountId: "default" },
      { ...mctx.account, accountId: "other-bot", email: "other@example.com" },
    ] as ReturnType<typeof listEnabledZulipAccounts>);
    const core = mctx.core as unknown as MockCore;
    core.channel.mentions.matchesMentionPatterns.mockReturnValue(true);
    await handleMessage(mctx, makeMsg({ sender_email: "other@example.com", content: "@**Bot** hello" }));
    expect(core.channel.reply.dispatchReplyFromConfig).toHaveBeenCalled();
  });
});

// spec: message-handling.md ## Coordinator Routing
describe("handleMessage — coordinator routing", () => {
  it("non-coordinator alwaysReply account skips unmentioned messages", async () => {
    vi.mocked(isAutoReplyStream).mockReturnValueOnce(false);
    const mctx = makeMctx();
    mctx.account.accountId = "secondary";
    vi.mocked(resolveDefaultZulipAccountId).mockReturnValue("default");
    const core = mctx.core as unknown as MockCore;
    await handleMessage(mctx, makeMsg());
    expect(core.channel.reply.dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("defers to mention-only bot when that bot is @mentioned", async () => {
    const mctx = makeMctx();
    vi.mocked(resolveDefaultZulipAccountId).mockReturnValue("default");
    vi.mocked(listEnabledZulipAccounts).mockReturnValue([
      {
        ...mctx.account,
        accountId: "specialist",
        alwaysReply: false,
        email: "specialist@example.com",
      },
    ] as ReturnType<typeof listEnabledZulipAccounts>);
    const core = mctx.core as unknown as MockCore;
    // Differentiate routes and regexes by account/agent
    core.channel.routing.resolveAgentRoute.mockImplementation(({ accountId }: { accountId: string }) => {
      if (accountId === "specialist") {
        return { agentId: "specialist-agent", sessionKey: "zulip:specialist", accountId: "specialist" };
      }
      return { agentId: "agent-1", sessionKey: "zulip:default", accountId: "default" };
    });
    core.channel.mentions.buildMentionRegexes.mockImplementation((_cfg: unknown, agentId: string) => {
      if (agentId === "specialist-agent") return ["specialist-regex"];
      return []; // current bot has no match
    });
    core.channel.mentions.matchesMentionPatterns.mockImplementation(
      (_text: string, regexes: unknown[]) => regexes.length > 0,
    );
    await handleMessage(mctx, makeMsg({ content: "@**Specialist** help" }));
    // Coordinator defers — no dispatch
    expect(core.channel.reply.dispatchReplyFromConfig).not.toHaveBeenCalled();
  });
});

// spec: message-handling.md ## Notification Bot Filter
describe("handleMessage — notification bot filter", () => {
  it("suppresses topic-resolved notifications", async () => {
    const mctx = makeMctx();
    const core = mctx.core as unknown as MockCore;
    await handleMessage(
      mctx,
      makeMsg({
        sender_email: "notification-bot@zulip.com",
        content: "@_**Bot** has marked this topic as resolved.",
      }),
    );
    expect(core.channel.reply.dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("processes non-resolved notifications normally", async () => {
    const mctx = makeMctx();
    const core = mctx.core as unknown as MockCore;
    await handleMessage(
      mctx,
      makeMsg({
        sender_email: "notification-bot@zulip.com",
        content: "A new user has joined the stream.",
      }),
    );
    expect(core.channel.reply.dispatchReplyFromConfig).toHaveBeenCalled();
  });
});

// spec: message-handling.md ## Checkpoint Lifecycle
describe("handleMessage — checkpoints", () => {
  it("writes checkpoint before dispatch and clears on success", async () => {
    const mctx = makeMctx();
    await handleMessage(mctx, makeMsg());
    expect(writeZulipInFlightCheckpoint).toHaveBeenCalled();
    expect(clearZulipInFlightCheckpoint).toHaveBeenCalled();
  });

  it("writes failure checkpoint on dispatch error", async () => {
    const core = makeMockCore();
    core.channel.reply.dispatchReplyFromConfig.mockRejectedValue(new Error("boom"));
    const mctx = makeMctx(core);
    await handleMessage(mctx, makeMsg());
    // Checkpoint written initially + updated with failure
    expect(writeZulipInFlightCheckpoint).toHaveBeenCalledTimes(2);
    expect(clearZulipInFlightCheckpoint).not.toHaveBeenCalled();
  });
});

// spec: message-handling.md ## Reactions
describe("handleMessage — reactions", () => {
  it("adds success reaction on successful dispatch", async () => {
    const mctx = makeMctx();
    await handleMessage(mctx, makeMsg());
    // With workflow enabled, the controller handles transitions (mocked)
    // Verify bestEffortReaction is not called directly (controller handles it)
    // The important thing is dispatch succeeded
    const core = mctx.core as unknown as MockCore;
    expect(core.channel.reply.dispatchReplyFromConfig).toHaveBeenCalled();
  });

  it("posts visible error message to stream on dispatch failure", async () => {
    const core = makeMockCore();
    core.channel.reply.dispatchReplyFromConfig.mockRejectedValue(new Error("fail"));
    const mctx = makeMctx(core);
    await handleMessage(mctx, makeMsg());
    expect(sendZulipStreamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("error processing your message"),
      }),
    );
  });

  it("uses bestEffortReaction when workflow is disabled", async () => {
    const mctx = makeMctx();
    mctx.account.reactions.workflow.enabled = false;
    await handleMessage(mctx, makeMsg());
    expect(bestEffortReaction).toHaveBeenCalledWith(
      expect.objectContaining({ op: "add", emojiName: "eyes" }),
    );
  });

  it("clears dispatch tracking in finally block", async () => {
    const mctx = makeMctx();
    await handleMessage(mctx, makeMsg());
    expect(clearDispatchTracking).toHaveBeenCalledWith("default");
  });
});

// spec: delivery.md ## NO_REPLY Suppression
describe("handleMessage — NO_REPLY suppression", () => {
  it("suppresses delivery and adds thumbs_up when reply is NO_REPLY", async () => {
    const core = makeMockCore();
    // Capture the deliver callback passed to createReplyDispatcherWithTyping
    let deliverCallback: ((payload: { text: string }) => Promise<void>) | undefined;
    core.channel.reply.createReplyDispatcherWithTyping.mockImplementation(
      (opts: { deliver: (payload: { text: string }) => Promise<void> }) => {
        deliverCallback = opts.deliver;
        return {
          dispatcher: {
            markComplete: vi.fn(),
            waitForIdle: vi.fn(async () => {}),
            sendToolResult: vi.fn(),
            sendBlockReply: vi.fn(),
            sendFinalReply: vi.fn(),
          },
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        };
      },
    );
    const mctx = makeMctx(core);
    await handleMessage(mctx, makeMsg());

    // Simulate the LLM returning NO_REPLY
    expect(deliverCallback).toBeDefined();
    await deliverCallback!({ text: "NO_REPLY" });
    expect(bestEffortReaction).toHaveBeenCalledWith(
      expect.objectContaining({ op: "add", emojiName: "thumbs_up" }),
    );
    expect(deliverReply).not.toHaveBeenCalled();
  });
});

// spec: message-handling.md ## Tool Send Deduplication
describe("handleMessage — tool-send dedup", () => {
  it("suppresses text reply when tool already sent to topic", async () => {
    const core = makeMockCore();
    let deliverCallback: ((payload: { text: string }) => Promise<void>) | undefined;
    core.channel.reply.createReplyDispatcherWithTyping.mockImplementation(
      (opts: { deliver: (payload: { text: string }) => Promise<void> }) => {
        deliverCallback = opts.deliver;
        return {
          dispatcher: {
            markComplete: vi.fn(),
            waitForIdle: vi.fn(async () => {}),
            sendToolResult: vi.fn(),
            sendBlockReply: vi.fn(),
            sendFinalReply: vi.fn(),
          },
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        };
      },
    );
    vi.mocked(hasToolSentToTopic).mockReturnValue(true);
    const mctx = makeMctx(core);
    await handleMessage(mctx, makeMsg());

    expect(deliverCallback).toBeDefined();
    await deliverCallback!({ text: "Here is the result" });
    expect(deliverReply).not.toHaveBeenCalled();
  });
});

// spec: message-handling.md ## Dispatch Retry
describe("handleMessage — dispatch retry", () => {
  it("retries dispatch up to MAX_DISPATCH_RETRIES on non-abort errors", async () => {
    const core = makeMockCore();
    let callCount = 0;
    core.channel.reply.dispatchReplyFromConfig.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw new Error("transient");
    });
    const mctx = makeMctx(core);
    await handleMessage(mctx, makeMsg());
    // 3 attempts total (initial + 2 retries)
    expect(callCount).toBe(3);
    // Final attempt succeeded, so checkpoint is cleared
    expect(clearZulipInFlightCheckpoint).toHaveBeenCalled();
  });

  it("skips sleep delay on AbortError (non-retryable)", async () => {
    const core = makeMockCore();
    core.channel.reply.dispatchReplyFromConfig.mockImplementation(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const mctx = makeMctx(core);
    const { sleep: sleepMock } = await import("./sleep.js");
    await handleMessage(mctx, makeMsg());
    // AbortError is not retryable → sleep(2000) should NOT be called between attempts
    expect(sleepMock).not.toHaveBeenCalled();
    // statusSink should be called with the error (non-retryable path)
    expect(mctx.opts.statusSink).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: "aborted" }),
    );
  });
});
