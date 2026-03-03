import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => {
  return {
    zulipRequest: vi.fn(async () => ({ result: "success", emoji: { "1": { name: "eyes" }, "2": { name: "thumbs_up" } } })),
    zulipRequestWithRetry: vi.fn(async () => ({ result: "success" })),
  };
});

import type { ZulipAuth } from "./client.js";
import { zulipRequest, zulipRequestWithRetry } from "./client.js";
import { addZulipReaction, removeZulipReaction, resolveEmojiNameCandidates } from "./reactions.js";

function makeAuth(id = "default"): ZulipAuth {
  return {
    baseUrl: "https://zulip.example",
    email: `bot+${id}@zulip.example`,
    apiKey: "not-a-real-key",
  };
}

// spec: reactions.md ## Emoji Resolution
describe("resolveEmojiNameCandidates", () => {
  it("maps common unicode emoji to deterministic Zulip names", () => {
    expect(resolveEmojiNameCandidates("👍")).toEqual(["thumbs_up", "+1", "👍"]);
    expect(resolveEmojiNameCandidates("✅")).toEqual(["check", "white_check_mark", "✅"]);
  });
});

// spec: reactions.md ## Remove Reaction
describe("removeZulipReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends emoji_name as query params", async () => {
    await removeZulipReaction({
      auth: makeAuth("remove"),
      messageId: 123,
      emojiName: ":eyes:",
    });

    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        path: "/api/v1/messages/123/reactions",
        query: { emoji_name: "eyes" },
      }),
    );
  });
});

// spec: reactions.md ## Add Reaction
// spec: reactions.md ## Emoji Directory
describe("addZulipReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends emoji_name as form params", async () => {
    await addZulipReaction({
      auth: makeAuth("add-basic"),
      messageId: 456,
      emojiName: ":eyes:",
    });

    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/messages/456/reactions",
        form: { emoji_name: "eyes" },
      }),
    );
  });

  it("maps unicode emoji to Zulip emoji names when available", async () => {
    vi.mocked(zulipRequest).mockResolvedValue({
      result: "success",
      emoji: { "1": { name: "thumbs_up" } },
    });

    await addZulipReaction({
      auth: makeAuth("add-map"),
      messageId: 789,
      emojiName: "👍",
    });

    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        form: { emoji_name: "thumbs_up" },
      }),
    );
  });

  it("skips unavailable emoji without throwing", async () => {
    const log = vi.fn();
    vi.mocked(zulipRequest).mockResolvedValue({
      result: "success",
      emoji: { "1": { name: "eyes" } },
    });

    await expect(
      addZulipReaction({
        auth: makeAuth("add-skip"),
        messageId: 999,
        emojiName: "🤷",
        log,
      }),
    ).resolves.toMatchObject({ result: "success" });

    expect(zulipRequestWithRetry).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/not available in this realm/i));
  });

  it("tries mapped fallbacks when emoji directory lookup is unavailable", async () => {
    vi.mocked(zulipRequest).mockRejectedValueOnce(new Error("directory unavailable"));
    vi.mocked(zulipRequestWithRetry).mockImplementation(async ({ form }) => {
      const emojiName = (form as { emoji_name: string }).emoji_name;
      if (emojiName === "thumbs_up") {
        const err = new Error("Zulip API error (400): Invalid emoji name");
        (err as { status?: number }).status = 400;
        throw err;
      }
      return { result: "success" };
    });

    await addZulipReaction({
      auth: makeAuth("add-fallback"),
      messageId: 1000,
      emojiName: "👍",
    });

    const triedEmojiNames = vi
      .mocked(zulipRequestWithRetry)
      .mock.calls.map(([arg]) => (arg.form as { emoji_name: string }).emoji_name);
    expect(triedEmojiNames).toContain("thumbs_up");
    expect(triedEmojiNames).toContain("+1");
  });
});

// spec: reactions.md ## Emoji Directory Cache
describe("emoji directory caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("caches emoji directory per auth identity", async () => {
    vi.mocked(zulipRequest).mockResolvedValue({
      result: "success",
      emoji: { "1": { name: "eyes" }, "2": { name: "check" } },
    });

    const auth = makeAuth("cache-1");
    await addZulipReaction({ auth, messageId: 1, emojiName: "eyes" });
    await addZulipReaction({ auth, messageId: 2, emojiName: "eyes" });

    // Emoji directory fetched once, second call uses cache
    expect(zulipRequest).toHaveBeenCalledTimes(1);
  });

  it("fetches independently for different auth identities", async () => {
    vi.mocked(zulipRequest).mockResolvedValue({
      result: "success",
      emoji: { "1": { name: "eyes" } },
    });

    await addZulipReaction({ auth: makeAuth("cache-a"), messageId: 1, emojiName: "eyes" });
    await addZulipReaction({ auth: makeAuth("cache-b"), messageId: 2, emojiName: "eyes" });

    // Each auth identity fetches its own directory
    expect(zulipRequest).toHaveBeenCalledTimes(2);
  });

  it("reads emoji .name from directory entry objects", async () => {
    vi.mocked(zulipRequest).mockResolvedValue({
      result: "success",
      emoji: {
        "1": { name: "custom_emoji", id: "1", deactivated: false },
        "2": { name: "another_one", id: "2", deactivated: false },
      },
    });

    const log = vi.fn();
    await addZulipReaction({ auth: makeAuth("parse"), messageId: 1, emojiName: "custom_emoji", log });
    // Should succeed — custom_emoji is in the directory
    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ form: { emoji_name: "custom_emoji" } }),
    );
  });

  it("fetches from /api/v1/realm/emoji", async () => {
    vi.mocked(zulipRequest).mockResolvedValue({
      result: "success",
      emoji: { "1": { name: "eyes" } },
    });

    await addZulipReaction({ auth: makeAuth("path-check"), messageId: 1, emojiName: "eyes" });

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/v1/realm/emoji" }),
    );
  });
});
