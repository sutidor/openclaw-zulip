import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendZulipStreamMessage: vi.fn(async () => ({ id: 1 })),
  resolveOutboundMedia: vi.fn(async () => ({ buffer: Buffer.from(""), contentType: "image/png", filename: "img.png" })),
  uploadZulipFile: vi.fn(async () => "https://zulip.example/user_uploads/uploaded.png"),
  getZulipRuntime: vi.fn(() => ({
    logging: { getChildLogger: () => ({ warn: vi.fn(), debug: vi.fn() }) },
    channel: { text: { chunkMarkdownText: (text: string, limit: number) => [text] } },
  })),
}));

vi.mock("openclaw/plugin-sdk", () => ({}));

vi.mock("../runtime.js", () => ({
  getZulipRuntime: mocks.getZulipRuntime,
}));

vi.mock("./send.js", () => ({
  sendZulipStreamMessage: mocks.sendZulipStreamMessage,
}));

vi.mock("./uploads.js", () => ({
  resolveOutboundMedia: mocks.resolveOutboundMedia,
  uploadZulipFile: mocks.uploadZulipFile,
}));

import { deliverReply } from "./deliver.js";

const baseParams = {
  account: { accountId: "default", textChunkLimit: 10_000 } as never,
  auth: { baseUrl: "https://zulip.example", email: "bot@example.com", apiKey: "key" },
  stream: "marcel",
  topic: "general",
  cfg: {} as never,
};

// spec: delivery.md ## Text Delivery
// spec: delivery.md ## Topic Directives
// spec: delivery.md ## Media Delivery
describe("deliverReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getZulipRuntime.mockReturnValue({
      logging: { getChildLogger: () => ({ warn: vi.fn(), debug: vi.fn() }) },
      channel: { text: { chunkMarkdownText: (text: string, _limit: number) => [text] } },
    });
  });
  it("sends a text reply", async () => {
    await deliverReply({ ...baseParams, payload: { text: "hello world" } });
    expect(mocks.sendZulipStreamMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "hello world", stream: "marcel", topic: "general" }),
    );
  });

  it("skips empty responses", async () => {
    await deliverReply({ ...baseParams, payload: { text: "  " } });
    expect(mocks.sendZulipStreamMessage).not.toHaveBeenCalled();
  });

  it("extracts topic directive and sends to new topic", async () => {
    await deliverReply({
      ...baseParams,
      payload: { text: "[[zulip_topic: new-topic]]\nhello" },
    });
    expect(mocks.sendZulipStreamMessage).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "new-topic", content: "hello" }),
    );
  });

  it("sends media with upload", async () => {
    await deliverReply({
      ...baseParams,
      payload: { text: "see this", mediaUrl: "file:///tmp/img.png" },
    });
    expect(mocks.resolveOutboundMedia).toHaveBeenCalled();
    expect(mocks.uploadZulipFile).toHaveBeenCalled();
    expect(mocks.sendZulipStreamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "see this\n\nhttps://zulip.example/user_uploads/uploaded.png",
      }),
    );
  });

  it("sends media without caption for empty text", async () => {
    await deliverReply({
      ...baseParams,
      payload: { text: "", mediaUrl: "file:///tmp/img.png" },
    });
    expect(mocks.sendZulipStreamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "https://zulip.example/user_uploads/uploaded.png",
      }),
    );
  });

  it("sends text chunks first when caption exceeds limit", async () => {
    const longText = "x".repeat(10_001);
    mocks.getZulipRuntime.mockReturnValue({
      logging: { getChildLogger: () => ({ warn: vi.fn(), debug: vi.fn() }) },
      channel: { text: { chunkMarkdownText: (text: string) => [text.slice(0, 5000), text.slice(5000)] } },
    });
    await deliverReply({
      ...baseParams,
      payload: { text: longText, mediaUrl: "file:///tmp/img.png" },
    });
    // Text chunks + media = at least 3 calls
    expect(mocks.sendZulipStreamMessage).toHaveBeenCalledTimes(3);
  });

  it("handles multiple mediaUrls", async () => {
    await deliverReply({
      ...baseParams,
      payload: { text: "caption", mediaUrls: ["file:///a.png", "file:///b.png"] },
    });
    expect(mocks.uploadZulipFile).toHaveBeenCalledTimes(2);
    // First call has caption, second does not
    expect(mocks.sendZulipStreamMessage).toHaveBeenCalledTimes(2);
    expect(mocks.sendZulipStreamMessage.mock.calls[0][0].content).toContain("caption");
    expect(mocks.sendZulipStreamMessage.mock.calls[1][0].content).not.toContain("caption");
  });
});
