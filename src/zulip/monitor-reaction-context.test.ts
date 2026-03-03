import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  zulipRequest: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  createReplyPrefixOptions: vi.fn(() => ({})),
}));

vi.mock("./client.js", () => ({
  zulipRequest: mocks.zulipRequest,
}));

import { createReactionMessageContextTracker } from "./monitor-reaction-context.js";

const auth = { baseUrl: "https://zulip.example", email: "bot@example.com", apiKey: "key" };

// spec: reactions.md ## Reaction Context Tracking
describe("createReactionMessageContextTracker", () => {
  describe("remember + resolve", () => {
    it("caches message context and returns it on resolve", async () => {
      const tracker = createReactionMessageContextTracker({ auth, defaultTopic: "general" });
      tracker.remember({
        id: 100,
        type: "stream",
        display_recipient: "marcel",
        subject: "deploy",
        sender_id: 42,
        stream_id: 5,
      } as never);
      const result = await tracker.resolve({ message_id: 100, op: "add", emoji_name: "fire" } as never);
      expect(result).toEqual({ stream: "marcel", topic: "deploy", streamId: 5, senderId: 42 });
    });

    it("ignores non-stream messages", async () => {
      const tracker = createReactionMessageContextTracker({ auth, defaultTopic: "general" });
      tracker.remember({
        id: 101,
        type: "private",
        display_recipient: "marcel",
        subject: "deploy",
      } as never);
      mocks.zulipRequest.mockRejectedValue(new Error("404"));
      const result = await tracker.resolve({ message_id: 101, op: "add", emoji_name: "fire" } as never);
      expect(result).toBeNull();
    });

    it("ignores messages with missing id", () => {
      const tracker = createReactionMessageContextTracker({ auth, defaultTopic: "general" });
      tracker.remember({ type: "stream", display_recipient: "marcel", subject: "deploy" } as never);
      // Should not throw
    });
  });

  describe("resolve with event-embedded message", () => {
    it("uses message data from the reaction event", async () => {
      const tracker = createReactionMessageContextTracker({ auth, defaultTopic: "general" });
      const result = await tracker.resolve({
        message_id: 200,
        op: "add",
        emoji_name: "check",
        message: {
          type: "stream",
          display_recipient: "ops",
          subject: "alerts",
          stream_id: 3,
          sender_id: 55,
        },
      } as never);
      expect(result).toEqual({ stream: "ops", topic: "alerts", streamId: 3, senderId: 55 });
    });
  });

  describe("resolve with API fallback", () => {
    it("fetches from API when not cached", async () => {
      mocks.zulipRequest.mockResolvedValue({
        message: {
          type: "stream",
          display_recipient: "backend",
          subject: "ci",
          stream_id: 7,
          sender_id: 99,
        },
      });
      const tracker = createReactionMessageContextTracker({ auth, defaultTopic: "general" });
      const result = await tracker.resolve({ message_id: 300, op: "add", emoji_name: "thumbs_up" } as never);
      expect(result).toEqual({ stream: "backend", topic: "ci", streamId: 7, senderId: 99 });
    });

    it("returns null when API fails", async () => {
      mocks.zulipRequest.mockRejectedValue(new Error("network"));
      const tracker = createReactionMessageContextTracker({ auth, defaultTopic: "general" });
      const result = await tracker.resolve({ message_id: 400, op: "add", emoji_name: "x" } as never);
      expect(result).toBeNull();
    });
  });

  describe("toCommandToken", () => {
    it("normalizes emoji names to clean tokens", () => {
      const tracker = createReactionMessageContextTracker({ auth, defaultTopic: "general" });
      expect(tracker.toCommandToken(":thumbs_up:")).toBe("thumbs_up");
      expect(tracker.toCommandToken("cross_mark")).toBe("cross_mark");
      expect(tracker.toCommandToken("+1")).toBe("+1");
      expect(tracker.toCommandToken("  :Fire!:  ")).toBe("fire");
    });

    it("returns 'emoji' for empty input", () => {
      const tracker = createReactionMessageContextTracker({ auth, defaultTopic: "general" });
      expect(tracker.toCommandToken("")).toBe("emoji");
      expect(tracker.toCommandToken(":::")).toBe("emoji");
    });
  });
});
