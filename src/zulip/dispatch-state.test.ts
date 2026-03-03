import { afterEach, describe, expect, it } from "vitest";
import { clearDispatchTracking, hasToolSentToTopic, trackToolSend } from "./dispatch-state.js";

// spec: message-handling.md ## Tool Send Deduplication
describe("dispatch-state", () => {
  afterEach(() => {
    clearDispatchTracking("acct1");
    clearDispatchTracking("acct2");
  });

  it("tracks and detects tool sends per account/stream/topic", () => {
    expect(hasToolSentToTopic("acct1", "marcel", "general")).toBe(false);
    trackToolSend("acct1", "marcel", "general");
    expect(hasToolSentToTopic("acct1", "marcel", "general")).toBe(true);
  });

  it("isolates tracking by account", () => {
    trackToolSend("acct1", "marcel", "general");
    expect(hasToolSentToTopic("acct2", "marcel", "general")).toBe(false);
  });

  it("isolates tracking by topic", () => {
    trackToolSend("acct1", "marcel", "general");
    expect(hasToolSentToTopic("acct1", "marcel", "deploy")).toBe(false);
  });

  it("clears tracking for an account", () => {
    trackToolSend("acct1", "marcel", "general");
    trackToolSend("acct1", "marcel", "deploy");
    clearDispatchTracking("acct1");
    expect(hasToolSentToTopic("acct1", "marcel", "general")).toBe(false);
    expect(hasToolSentToTopic("acct1", "marcel", "deploy")).toBe(false);
  });

  it("clearing one account does not affect another", () => {
    trackToolSend("acct1", "marcel", "general");
    trackToolSend("acct2", "marcel", "general");
    clearDispatchTracking("acct1");
    expect(hasToolSentToTopic("acct2", "marcel", "general")).toBe(true);
  });
});
