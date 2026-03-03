import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  zulipRequest: vi.fn(async () => ({ result: "success" })),
}));

vi.mock("./client.js", () => ({
  zulipRequest: mocks.zulipRequest,
}));

import type { ZulipAuth } from "./client.js";
import { replyToDm, shouldIgnoreMessage, startTypingRefresh } from "./messaging.js";

const auth: ZulipAuth = { baseUrl: "https://zulip.example", email: "bot@example.com", apiKey: "key" };

// spec: message-handling.md ## Ignore Rules
describe("shouldIgnoreMessage", () => {
  it("ignores messages from self", () => {
    const result = shouldIgnoreMessage({
      message: { id: 1, type: "stream", sender_id: 42, display_recipient: "marcel" } as never,
      botUserId: 42,
      streams: ["marcel"],
    });
    expect(result).toEqual({ ignore: true, reason: "self" });
  });

  it("ignores DMs", () => {
    const result = shouldIgnoreMessage({
      message: { id: 1, type: "private", sender_id: 10, display_recipient: "marcel" } as never,
      botUserId: 42,
      streams: ["marcel"],
    });
    expect(result).toEqual({ ignore: true, reason: "dm" });
  });

  it("ignores messages from disallowed streams", () => {
    const result = shouldIgnoreMessage({
      message: { id: 1, type: "stream", sender_id: 10, display_recipient: "other" } as never,
      botUserId: 42,
      streams: ["marcel"],
    });
    expect(result).toEqual({ ignore: true, reason: "not-allowed-stream" });
  });

  it("ignores messages with missing stream", () => {
    const result = shouldIgnoreMessage({
      message: { id: 1, type: "stream", sender_id: 10, display_recipient: "" } as never,
      botUserId: 42,
      streams: [],
    });
    expect(result).toEqual({ ignore: true, reason: "missing-stream" });
  });

  it("accepts valid stream messages", () => {
    const result = shouldIgnoreMessage({
      message: { id: 1, type: "stream", sender_id: 10, display_recipient: "marcel" } as never,
      botUserId: 42,
      streams: ["marcel"],
    });
    expect(result).toEqual({ ignore: false });
  });

  it("accepts all streams when streams list is empty", () => {
    const result = shouldIgnoreMessage({
      message: { id: 1, type: "stream", sender_id: 10, display_recipient: "anything" } as never,
      botUserId: 42,
      streams: [],
    });
    expect(result).toEqual({ ignore: false });
  });
});

// spec: message-handling.md ## DM Redirect
describe("replyToDm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("sends a DM redirect to new senders", async () => {
    const notified = new Set<number>();
    await replyToDm({ auth, senderId: 10, dmNotifiedSenders: notified });
    expect(mocks.zulipRequest).toHaveBeenCalledOnce();
    expect(notified.has(10)).toBe(true);
  });

  it("does not send duplicate DM redirects", async () => {
    const notified = new Set<number>([10]);
    await replyToDm({ auth, senderId: 10, dmNotifiedSenders: notified });
    expect(mocks.zulipRequest).not.toHaveBeenCalled();
  });
});

// spec: monitor.md ## Typing Indicators
describe("startTypingRefresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends an initial typing indicator and sets up refresh", () => {
    vi.useFakeTimers();
    const stop = startTypingRefresh({ auth, streamId: 1, topic: "general", intervalMs: 100 });
    expect(mocks.zulipRequest).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(100);
    expect(mocks.zulipRequest).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(200);
    expect(mocks.zulipRequest).toHaveBeenCalledTimes(2);
  });
});
