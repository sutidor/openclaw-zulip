import { describe, expect, it } from "vitest";
import { sleep } from "./sleep.js";

// spec: http-client.md ## Sleep
describe("sleep", () => {
  it("resolves immediately for 0ms", async () => {
    await sleep(0);
  });

  it("resolves immediately for negative ms", async () => {
    await sleep(-100);
  });

  it("resolves after the specified delay", async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it("rejects with AbortError when signal is aborted", async () => {
    const controller = new AbortController();
    const promise = sleep(10_000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow("aborted");
    try {
      await promise;
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }
  });

  it("resolves normally when signal is not aborted", async () => {
    const controller = new AbortController();
    await sleep(10, controller.signal);
  });
});
