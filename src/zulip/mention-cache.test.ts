import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({}));

import {
  getMentionDisplayNames,
  normalizeMentions,
  normalizeMentionText,
  updateMentionDisplayNames,
} from "./mention-cache.js";

// spec: message-handling.md ## Mention Normalization
describe("mention-cache", () => {
  it("stores and retrieves display names", () => {
    updateMentionDisplayNames(new Map([["bot", "Bot Name"]]));
    expect(getMentionDisplayNames().get("bot")).toBe("Bot Name");
  });

  it("merges names across updates", () => {
    updateMentionDisplayNames(new Map([["a", "Alice"]]));
    updateMentionDisplayNames(new Map([["b", "Bob"]]));
    const names = getMentionDisplayNames();
    expect(names.get("a")).toBe("Alice");
    expect(names.get("b")).toBe("Bob");
  });

  describe("normalizeMentionText", () => {
    it("replaces plain @emailPrefix with @**Display Name**", () => {
      const names = new Map([["amira-bot", "Amira"]]);
      expect(normalizeMentionText("ping @amira-bot please", names)).toBe(
        "ping @**Amira** please",
      );
    });

    it("replaces @**emailPrefix** with @**Display Name**", () => {
      const names = new Map([["amira-bot", "Amira"]]);
      expect(normalizeMentionText("ping @**amira-bot** please", names)).toBe(
        "ping @**Amira** please",
      );
    });

    it("is case-insensitive", () => {
      const names = new Map([["amira-bot", "Amira"]]);
      expect(normalizeMentionText("hi @Amira-Bot", names)).toBe("hi @**Amira**");
    });

    it("returns input unchanged when no matches", () => {
      const names = new Map([["amira-bot", "Amira"]]);
      expect(normalizeMentionText("no mentions here", names)).toBe("no mentions here");
    });

    it("returns input unchanged with empty map", () => {
      expect(normalizeMentionText("hi @someone", new Map())).toBe("hi @someone");
    });

    it("returns empty string unchanged", () => {
      const names = new Map([["a", "A"]]);
      expect(normalizeMentionText("", names)).toBe("");
    });

    it("escapes regex special characters in prefixes", () => {
      const names = new Map([["user+tag", "User Tag"]]);
      expect(normalizeMentionText("hi @user+tag", names)).toBe("hi @**User Tag**");
    });
  });

  describe("normalizeMentions", () => {
    it("normalizes mentions in a ReplyPayload", () => {
      const names = new Map([["amira-bot", "Amira"]]);
      const payload = { text: "cc @amira-bot" };
      const result = normalizeMentions(payload, names);
      expect(result.text).toBe("cc @**Amira**");
    });

    it("returns same payload reference when nothing changes", () => {
      const names = new Map([["amira-bot", "Amira"]]);
      const payload = { text: "no mentions" };
      expect(normalizeMentions(payload, names)).toBe(payload);
    });

    it("returns same payload reference with empty map", () => {
      const payload = { text: "hi @someone" };
      expect(normalizeMentions(payload, new Map())).toBe(payload);
    });

    it("returns same payload reference with no text", () => {
      const payload = {};
      const names = new Map([["a", "A"]]);
      expect(normalizeMentions(payload as { text?: string }, names)).toBe(payload);
    });
  });
});
