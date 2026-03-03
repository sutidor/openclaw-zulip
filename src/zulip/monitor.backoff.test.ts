import { describe, expect, it, vi } from "vitest";
import { computeZulipMonitorBackoffMs, extractZulipHttpStatus } from "./backoff.js";

// spec: http-client.md ## Monitor-Level Backoff
describe("computeZulipMonitorBackoffMs", () => {
  it("respects retry-after when higher than exponential", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(
      computeZulipMonitorBackoffMs({
        attempt: 1,
        status: 429,
        retryAfterMs: 10_000,
      }),
    ).toBeGreaterThanOrEqual(10_000);
    vi.restoreAllMocks();
  });

  it("increases with attempts for 429", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const a1 = computeZulipMonitorBackoffMs({ attempt: 1, status: 429 });
    const a2 = computeZulipMonitorBackoffMs({ attempt: 2, status: 429 });
    const a3 = computeZulipMonitorBackoffMs({ attempt: 3, status: 429 });
    expect(a2).toBeGreaterThan(a1);
    expect(a3).toBeGreaterThan(a2);
    vi.restoreAllMocks();
  });
});

// spec: http-client.md ## Error Status Extraction
describe("extractZulipHttpStatus", () => {
  it("extracts status from error.status property", () => {
    expect(extractZulipHttpStatus({ status: 429 })).toBe(429);
  });

  it("extracts status from error message string", () => {
    expect(extractZulipHttpStatus(new Error("Zulip API error (502): bad gateway"))).toBe(502);
  });

  it("returns null for errors without status", () => {
    expect(extractZulipHttpStatus(new Error("network timeout"))).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(extractZulipHttpStatus(null)).toBeNull();
    expect(extractZulipHttpStatus(undefined)).toBeNull();
  });

  it("returns null for non-numeric status property", () => {
    expect(extractZulipHttpStatus({ status: "bad" })).toBeNull();
  });

  it("returns null for NaN/Infinity status", () => {
    expect(extractZulipHttpStatus({ status: NaN })).toBeNull();
    expect(extractZulipHttpStatus({ status: Infinity })).toBeNull();
  });
});
