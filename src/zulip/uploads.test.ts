import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  resolveChannelMediaMaxBytes: () => 5 * 1024 * 1024,
}));

import { extractZulipUploadUrls } from "./uploads.js";

// spec: uploads.md ## URL Extraction
// spec: uploads.md ## Origin Validation
describe("zulip uploads", () => {
  it("extracts relative /user_uploads links", () => {
    const urls = extractZulipUploadUrls(
      "see this: [file](/user_uploads/abc123/photo.png)",
      "https://zulip.example.com",
    );
    expect(urls).toEqual(["https://zulip.example.com/user_uploads/abc123/photo.png"]);
  });

  it("extracts absolute URLs and trims markdown delimiters", () => {
    const urls = extractZulipUploadUrls(
      "img: https://zulip.example.com/user_uploads/xyz/cat.jpg).",
      "https://zulip.example.com/",
    );
    expect(urls).toEqual(["https://zulip.example.com/user_uploads/xyz/cat.jpg"]);
  });

  it("dedupes and rejects uploads on other origins", () => {
    const urls = extractZulipUploadUrls(
      [
        "one: /user_uploads/a.png",
        "two: https://zulip.example.com/user_uploads/a.png",
        "bad: https://evil.example.com/user_uploads/pwn.png",
      ].join("\n"),
      "https://zulip.example.com",
    );
    expect(urls).toEqual(["https://zulip.example.com/user_uploads/a.png"]);
  });
});
