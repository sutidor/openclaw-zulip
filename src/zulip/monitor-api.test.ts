import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  zulipRequest: vi.fn(),
  getZulipRuntime: vi.fn(() => ({
    logging: { getChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
  })),
}));

vi.mock("./client.js", () => ({
  zulipRequest: mocks.zulipRequest,
}));

vi.mock("../runtime.js", () => ({
  getZulipRuntime: mocks.getZulipRuntime,
}));

import { buildAuth, fetchZulipUser, registerQueue } from "./monitor-api.js";

// spec: monitor.md ## Authentication
describe("buildAuth", () => {
  it("returns auth object from a fully configured account", () => {
    const auth = buildAuth({
      baseUrl: "https://zulip.example",
      email: "bot@example.com",
      apiKey: "key",
    } as never);
    expect(auth).toEqual({
      baseUrl: "https://zulip.example",
      email: "bot@example.com",
      apiKey: "key",
    });
  });

  it("throws when baseUrl is missing", () => {
    expect(() =>
      buildAuth({ baseUrl: "", email: "bot@example.com", apiKey: "key" } as never),
    ).toThrow("Missing zulip baseUrl/email/apiKey");
  });

  it("throws when email is missing", () => {
    expect(() =>
      buildAuth({ baseUrl: "https://z", email: "", apiKey: "key" } as never),
    ).toThrow("Missing zulip baseUrl/email/apiKey");
  });

  it("throws when apiKey is missing", () => {
    expect(() =>
      buildAuth({ baseUrl: "https://z", email: "bot@example.com", apiKey: "" } as never),
    ).toThrow("Missing zulip baseUrl/email/apiKey");
  });
});

// spec: monitor.md ## Queue Registration
describe("registerQueue", () => {
  it("returns queueId and lastEventId on success", async () => {
    mocks.zulipRequest.mockResolvedValue({
      result: "success",
      queue_id: "q1",
      last_event_id: 5,
    });
    const result = await registerQueue({
      auth: { baseUrl: "https://z", email: "bot@example.com", apiKey: "key" },
      stream: "marcel",
    });
    expect(result).toEqual({ queueId: "q1", lastEventId: 5 });
  });

  it("throws on error result", async () => {
    mocks.zulipRequest.mockResolvedValue({
      result: "error",
      msg: "rate limited",
    });
    await expect(
      registerQueue({
        auth: { baseUrl: "https://z", email: "bot@example.com", apiKey: "key" },
        stream: "marcel",
      }),
    ).rejects.toThrow("rate limited");
  });

  it("throws when queue_id is missing", async () => {
    mocks.zulipRequest.mockResolvedValue({
      result: "success",
      last_event_id: 5,
    });
    await expect(
      registerQueue({
        auth: { baseUrl: "https://z", email: "bot@example.com", apiKey: "key" },
        stream: "marcel",
      }),
    ).rejects.toThrow("Failed to register");
  });
});

// spec: accounts.md ## User Lookup
describe("fetchZulipUser", () => {
  it("returns user on success", async () => {
    mocks.zulipRequest.mockResolvedValue({
      result: "success",
      user: { user_id: 42, full_name: "Bot", email: "bot@example.com" },
    });
    const user = await fetchZulipUser(
      { baseUrl: "https://z", email: "bot@example.com", apiKey: "key" },
      "bot@example.com",
    );
    expect(user).toEqual({ user_id: 42, full_name: "Bot", email: "bot@example.com" });
  });

  it("returns null on error result", async () => {
    mocks.zulipRequest.mockResolvedValue({ result: "error" });
    const user = await fetchZulipUser(
      { baseUrl: "https://z", email: "bot@example.com", apiKey: "key" },
      "bot@example.com",
    );
    expect(user).toBeNull();
  });

  it("returns null on exception", async () => {
    mocks.zulipRequest.mockRejectedValue(new Error("network"));
    const user = await fetchZulipUser(
      { baseUrl: "https://z", email: "bot@example.com", apiKey: "key" },
      "bot@example.com",
    );
    expect(user).toBeNull();
  });
});
