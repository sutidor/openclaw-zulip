import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => ({
  zulipRequest: vi.fn(async () => ({ result: "success" })),
}));

vi.mock("./monitor-api.js", () => ({
  registerQueue: vi.fn(async () => ({ queueId: "queue-1", lastEventId: 0 })),
  pollEvents: vi.fn(async () => ({ result: "success", events: [] })),
}));

vi.mock("./messaging.js", () => ({
  replyToDm: vi.fn(async () => {}),
}));

vi.mock("./topic-rename.js", () => ({
  parseTopicRenameEvent: vi.fn(() => null),
  recordTopicRenameAlias: vi.fn(() => false),
}));

vi.mock("./sleep.js", () => ({
  sleep: vi.fn(async () => {}),
}));

vi.mock("./backoff.js", () => ({
  computeZulipMonitorBackoffMs: vi.fn(() => 100),
  extractZulipHttpStatus: vi.fn(() => null),
}));

import type { MonitorContext, ZulipEventMessage, ZulipEvent } from "./monitor-types.js";
import type { PollStreamHandlers } from "./monitor-poll.js";
import { pollStreamQueue } from "./monitor-poll.js";
import { registerQueue, pollEvents } from "./monitor-api.js";
import { zulipRequest } from "./client.js";
import { replyToDm } from "./messaging.js";
import { parseTopicRenameEvent, recordTopicRenameAlias } from "./topic-rename.js";
import { sleep } from "./sleep.js";
import { computeZulipMonitorBackoffMs } from "./backoff.js";

let stopFlag = false;
let pollCallCount = 0;

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
        workflow: { enabled: false, replaceStageReaction: true, minTransitionMs: 1500, stages: { success: "check_mark", failure: "warning" } },
        genericCallback: { enabled: false, includeRemoveOps: false, allowedEmojis: [], emojiSemantics: {} },
      },
      textChunkLimit: 10_000,
      config: {},
    },
    auth: { baseUrl: "https://zulip.example", email: "bot@example.com", apiKey: "key" },
    cfg: { channels: { zulip: { enabled: true } } },
    core: {} as unknown as MonitorContext["core"],
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
    stopped: () => stopFlag,
  };
}

function makeHandlers(): PollStreamHandlers & {
  handleMessageCalls: ZulipEventMessage[];
  handleReactionCalls: unknown[];
  rememberCalls: ZulipEventMessage[];
} {
  const handleMessageCalls: ZulipEventMessage[] = [];
  const handleReactionCalls: unknown[] = [];
  const rememberCalls: ZulipEventMessage[] = [];
  return {
    handleMessageCalls,
    handleReactionCalls,
    rememberCalls,
    handleMessage: vi.fn(async (msg: ZulipEventMessage) => {
      handleMessageCalls.push(msg);
    }),
    handleReaction: vi.fn(async (evt: unknown) => {
      handleReactionCalls.push(evt);
    }),
    rememberReactionContext: vi.fn((msg: ZulipEventMessage) => {
      rememberCalls.push(msg);
    }),
  };
}

function makeMessage(id: number, overrides?: Partial<ZulipEventMessage>): ZulipEventMessage {
  return {
    id,
    type: "stream",
    sender_id: 200,
    display_recipient: "marcel-ai",
    subject: "general chat",
    content: "Hello",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stopFlag = false;
  pollCallCount = 0;

  // Default: register succeeds, poll returns no events then stops
  vi.mocked(registerQueue).mockResolvedValue({ queueId: "queue-1", lastEventId: 0 });
  vi.mocked(pollEvents).mockImplementation(async () => {
    pollCallCount++;
    if (pollCallCount >= 2) stopFlag = true;
    return { result: "success", events: [] };
  });
});

afterEach(() => {
  stopFlag = true;
  vi.useRealTimers();
});

// spec: monitor.md ## Queue Registration
describe("pollStreamQueue — registration", () => {
  it("registers a queue before polling", async () => {
    stopFlag = false;
    vi.mocked(pollEvents).mockImplementation(async () => {
      stopFlag = true;
      return { result: "success", events: [] };
    });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    await pollStreamQueue(mctx, "marcel-ai", handlers);

    expect(registerQueue).toHaveBeenCalledWith(
      expect.objectContaining({ stream: "marcel-ai" }),
    );
  });

  it("deletes queue on shutdown", async () => {
    vi.mocked(pollEvents).mockImplementation(async () => {
      stopFlag = true;
      return { result: "success", events: [] };
    });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    await pollStreamQueue(mctx, "marcel-ai", handlers);

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        path: "/api/v1/events",
        form: { queue_id: "queue-1" },
      }),
    );
  });
});

// spec: monitor.md ## Event Processing
describe("pollStreamQueue — message events", () => {
  it("dispatches messages to handleMessage", async () => {
    const msg = makeMessage(1);
    vi.mocked(pollEvents).mockImplementation(async () => {
      stopFlag = true;
      return {
        result: "success",
        events: [{ id: 1, type: "message", message: msg }],
      };
    });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    await pollStreamQueue(mctx, "marcel-ai", handlers);

    // Wait for async throttled handler to complete
    await vi.waitFor(() => expect(handlers.handleMessageCalls).toHaveLength(1));
    expect(handlers.handleMessageCalls[0]?.id).toBe(1);
  });

  it("remembers reaction context for each message", async () => {
    const msg = makeMessage(1);
    vi.mocked(pollEvents).mockImplementation(async () => {
      stopFlag = true;
      return {
        result: "success",
        events: [{ id: 1, type: "message", message: msg }],
      };
    });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    await pollStreamQueue(mctx, "marcel-ai", handlers);
    expect(handlers.rememberCalls).toHaveLength(1);
  });

  it("updates lastEventId from events", async () => {
    vi.mocked(pollEvents)
      .mockImplementationOnce(async () => ({
        result: "success",
        events: [{ id: 5, type: "message", message: makeMessage(10) }],
      }))
      .mockImplementation(async ({ lastEventId }) => {
        // Second poll should use updated lastEventId
        expect(lastEventId).toBe(5);
        stopFlag = true;
        return { result: "success", events: [] };
      });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    await pollStreamQueue(mctx, "marcel-ai", handlers);
  });
});

// spec: monitor.md ## Reaction Events
describe("pollStreamQueue — reaction events", () => {
  it("dispatches reaction events to handleReaction", async () => {
    vi.mocked(pollEvents).mockImplementation(async () => {
      stopFlag = true;
      return {
        result: "success",
        events: [{
          id: 1,
          type: "reaction",
          op: "add",
          message_id: 42,
          emoji_name: "thumbs_up",
          emoji_code: "1f44d",
          user_id: 200,
        } as ZulipEvent],
      };
    });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    await pollStreamQueue(mctx, "marcel-ai", handlers);
    expect(handlers.handleReactionCalls).toHaveLength(1);
  });

  it("catches and logs errors from reaction handler", async () => {
    vi.mocked(pollEvents).mockImplementation(async () => {
      stopFlag = true;
      return {
        result: "success",
        events: [{
          id: 1,
          type: "reaction",
          op: "add",
          message_id: 42,
          emoji_name: "thumbs_up",
          emoji_code: "1f44d",
          user_id: 200,
        } as ZulipEvent],
      };
    });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    vi.mocked(handlers.handleReaction).mockRejectedValue(new Error("reaction boom"));
    await pollStreamQueue(mctx, "marcel-ai", handlers);
    expect(mctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("reaction handling failed"));
  });
});

// spec: monitor.md ## DM Redirect
describe("pollStreamQueue — DM handling", () => {
  it("sends DM redirect for non-stream messages from non-bot users", async () => {
    vi.mocked(pollEvents).mockImplementation(async () => {
      stopFlag = true;
      return {
        result: "success",
        events: [{
          id: 1,
          type: "message",
          message: makeMessage(10, { type: "private", sender_id: 300 }),
        }],
      };
    });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    await pollStreamQueue(mctx, "marcel-ai", handlers);
    expect(replyToDm).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: 300 }),
    );
  });

  it("does not send DM redirect for bot's own DMs", async () => {
    vi.mocked(pollEvents).mockImplementation(async () => {
      stopFlag = true;
      return {
        result: "success",
        events: [{
          id: 1,
          type: "message",
          message: makeMessage(10, { type: "private", sender_id: 100 }),
        }],
      };
    });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    await pollStreamQueue(mctx, "marcel-ai", handlers);
    expect(replyToDm).not.toHaveBeenCalled();
  });
});

// spec: monitor.md ## Topic Rename Tracking
describe("pollStreamQueue — topic renames", () => {
  it("records topic rename aliases", async () => {
    vi.mocked(parseTopicRenameEvent).mockReturnValue({
      fromTopic: "old-topic",
      toTopic: "new-topic",
    });
    vi.mocked(recordTopicRenameAlias).mockReturnValue(true);
    vi.mocked(pollEvents).mockImplementation(async () => {
      stopFlag = true;
      return {
        result: "success",
        events: [{
          id: 1,
          type: "update_message",
          orig_subject: "old-topic",
          subject: "new-topic",
        } as ZulipEvent],
      };
    });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    await pollStreamQueue(mctx, "marcel-ai", handlers);

    expect(recordTopicRenameAlias).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "marcel-ai",
        fromTopic: "old-topic",
        toTopic: "new-topic",
      }),
    );
    expect(mctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("mapped topic rename alias"));
  });
});

// spec: monitor.md ## Error Recovery
describe("pollStreamQueue — error handling", () => {
  it("clears queueId and backs off on error", async () => {
    let errorThrown = false;
    vi.mocked(pollEvents).mockImplementation(async () => {
      if (!errorThrown) {
        errorThrown = true;
        throw new Error("connection reset");
      }
      stopFlag = true;
      return { result: "success", events: [] };
    });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    await pollStreamQueue(mctx, "marcel-ai", handlers);

    expect(computeZulipMonitorBackoffMs).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1 }),
    );
    expect(sleep).toHaveBeenCalled();
    // Re-registered after error
    expect(registerQueue).toHaveBeenCalledTimes(2);
  });

  it("logs abort errors and re-registers queue", async () => {
    let errorThrown = false;
    vi.mocked(pollEvents).mockImplementation(async () => {
      if (!errorThrown) {
        errorThrown = true;
        const err = new Error("request aborted");
        err.name = "AbortError";
        throw err;
      }
      stopFlag = true;
      return { result: "success", events: [] };
    });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    await pollStreamQueue(mctx, "marcel-ai", handlers);

    expect(mctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("poll timeout/abort detected"),
    );
    expect(registerQueue).toHaveBeenCalledTimes(2);
  });

  it("throws poll error as Error when result is not success", async () => {
    let errorThrown = false;
    vi.mocked(pollEvents).mockImplementation(async () => {
      if (!errorThrown) {
        errorThrown = true;
        return { result: "error", msg: "Queue does not exist" };
      }
      stopFlag = true;
      return { result: "success", events: [] };
    });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    await pollStreamQueue(mctx, "marcel-ai", handlers);

    // Should have re-registered after the error
    expect(registerQueue).toHaveBeenCalledTimes(2);
    expect(mctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Queue does not exist"),
    );
  });
});

// spec: monitor.md ## Defensive Throttle
describe("pollStreamQueue — defensive throttle", () => {
  it("sleeps when poll returns no messages or reactions", async () => {
    let calls = 0;
    vi.mocked(pollEvents).mockImplementation(async () => {
      calls++;
      if (calls >= 2) stopFlag = true;
      return { result: "success", events: [] };
    });

    const mctx = makeMctx();
    const handlers = makeHandlers();
    await pollStreamQueue(mctx, "marcel-ai", handlers);

    // sleep called for defensive throttle on empty events
    expect(sleep).toHaveBeenCalled();
  });
});
