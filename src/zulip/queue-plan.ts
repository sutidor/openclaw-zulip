export type ZulipQueuePlanEntry = { stream: string };

export function buildZulipQueuePlan(streams: string[]): ZulipQueuePlanEntry[] {
  const normalized = streams.map((stream) => stream.trim()).filter(Boolean);
  const deduped = Array.from(new Set(normalized));
  return deduped.map((stream) => ({ stream }));
}

export function buildZulipRegisterNarrow(stream: string): string {
  return JSON.stringify([["channel", stream]]);
}
