import { describe, expect, it } from "vitest";
import { buildTopicKey, extractZulipTopicDirective } from "./topic-rename.js";

// spec: monitor.md ## Topic Key Hashing
describe("buildTopicKey", () => {
  it("encodes short topics as URI components", () => {
    expect(buildTopicKey("general")).toBe("general");
  });

  it("normalizes case", () => {
    expect(buildTopicKey("General")).toBe("general");
  });

  it("trims whitespace", () => {
    expect(buildTopicKey("  general  ")).toBe("general");
  });

  it("encodes special characters", () => {
    expect(buildTopicKey("hello world")).toBe("hello%20world");
  });

  it("uses hash truncation for long topics", () => {
    const longTopic = "a".repeat(100);
    const key = buildTopicKey(longTopic);
    expect(key.length).toBeLessThan(100);
    expect(key).toContain("~");
  });

  it("produces different hashes for different long topics", () => {
    const key1 = buildTopicKey("a".repeat(100));
    const key2 = buildTopicKey("b".repeat(100));
    expect(key1).not.toBe(key2);
  });
});

// spec: delivery.md ## Topic Directives
describe("extractZulipTopicDirective", () => {
  it("returns text unchanged when no directive present", () => {
    const result = extractZulipTopicDirective("hello world");
    expect(result).toEqual({ text: "hello world" });
  });

  it("extracts topic and remaining text", () => {
    const result = extractZulipTopicDirective("[[zulip_topic: deploy]]\nHere is the update");
    expect(result.topic).toBe("deploy");
    expect(result.text).toBe("Here is the update");
  });

  it("is case-insensitive", () => {
    const result = extractZulipTopicDirective("[[ZULIP_TOPIC: Deploy]]\ntext");
    expect(result.topic).toBe("Deploy");
  });

  it("handles whitespace around directive", () => {
    const result = extractZulipTopicDirective("  [[zulip_topic:  my topic  ]]  \ntext");
    expect(result.topic).toBe("my topic");
  });

  it("truncates topics longer than 60 characters", () => {
    const longTopic = "a".repeat(70);
    const result = extractZulipTopicDirective(`[[zulip_topic: ${longTopic}]]\ntext`);
    expect(result.topic!.length).toBeLessThanOrEqual(60);
  });

  it("handles empty directive gracefully", () => {
    const result = extractZulipTopicDirective("[[zulip_topic:  ]]\ntext");
    expect(result.topic).toBeUndefined();
    expect(result.text).toBe("text");
  });

  it("handles empty input", () => {
    const result = extractZulipTopicDirective("");
    expect(result).toEqual({ text: "" });
  });
});
