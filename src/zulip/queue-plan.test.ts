import { describe, expect, it } from "vitest";
import { buildZulipQueuePlan, buildZulipRegisterNarrow } from "./queue-plan.js";

// spec: monitor.md ## Queue Plan
describe("zulip queue plan", () => {
  it("dedupes and trims streams", () => {
    expect(
      buildZulipQueuePlan([" marcel-ai ", "marcel-ai", "", "  ", "ops"]).map((entry) => entry),
    ).toEqual([{ stream: "marcel-ai" }, { stream: "ops" }]);
  });

  it("builds a channel narrow", () => {
    expect(buildZulipRegisterNarrow("marcel-ai")).toBe('[["channel","marcel-ai"]]');
  });
});
