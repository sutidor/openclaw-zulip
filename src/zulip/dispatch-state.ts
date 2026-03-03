/**
 * Per-dispatch tracking of tool-sent messages.
 *
 * When the LLM uses the `send` action to send a message to the same
 * stream/topic it is already replying in, the text reply that follows
 * is redundant. The monitor deliver callback checks this state and
 * suppresses the duplicate.
 *
 * Keyed by accountId → set of "stream#topic" keys.
 */
const toolSends = new Map<string, Set<string>>();

function topicKey(stream: string, topic: string): string {
  return `${stream}#${topic}`;
}

export function trackToolSend(accountId: string, stream: string, topic: string): void {
  let sends = toolSends.get(accountId);
  if (!sends) {
    sends = new Set();
    toolSends.set(accountId, sends);
  }
  sends.add(topicKey(stream, topic));
}

export function hasToolSentToTopic(accountId: string, stream: string, topic: string): boolean {
  return toolSends.get(accountId)?.has(topicKey(stream, topic)) ?? false;
}

export function clearDispatchTracking(accountId: string): void {
  toolSends.delete(accountId);
}
