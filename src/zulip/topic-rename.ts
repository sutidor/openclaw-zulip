import crypto from "node:crypto";
import { normalizeTopic } from "./normalize.js";

export function buildTopicKey(topic: string): string {
  const normalized = topic.trim().toLowerCase();
  const encoded = encodeURIComponent(normalized);
  if (encoded.length <= 80) {
    return encoded;
  }
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${encoded.slice(0, 64)}~${digest}`;
}

type ZulipUpdateMessageEvent = {
  id?: number;
  type: "update_message";
  subject?: string;
  orig_subject?: string;
  topic?: string;
  orig_topic?: string;
};

type ZulipEvent = {
  id?: number;
  type?: string;
  subject?: string;
  orig_subject?: string;
  topic?: string;
  orig_topic?: string;
};

function isZulipUpdateMessageEvent(event: ZulipEvent): event is ZulipUpdateMessageEvent {
  return event.type === "update_message";
}

export function parseTopicRenameEvent(
  event: ZulipEvent,
): { fromTopic: string; toTopic: string } | undefined {
  if (!isZulipUpdateMessageEvent(event)) {
    return undefined;
  }

  const fromTopic = normalizeTopic(event.orig_topic ?? event.orig_subject);
  const toTopic = normalizeTopic(event.topic ?? event.subject);
  if (!fromTopic || !toTopic) {
    return undefined;
  }

  if (buildTopicKey(fromTopic) === buildTopicKey(toTopic)) {
    return undefined;
  }

  return { fromTopic, toTopic };
}

export function resolveCanonicalTopicSessionKey(params: {
  aliasesByStream: Map<string, Map<string, string>>;
  stream: string;
  topic: string;
}): string {
  const aliases = params.aliasesByStream.get(params.stream);
  const topicKey = buildTopicKey(params.topic);
  if (!aliases) {
    return topicKey;
  }

  let canonicalKey = topicKey;
  const visited = new Set<string>();
  const visitedOrder: string[] = [];

  while (true) {
    const next = aliases.get(canonicalKey);
    if (!next || next === canonicalKey || visited.has(canonicalKey)) {
      break;
    }
    visited.add(canonicalKey);
    visitedOrder.push(canonicalKey);
    canonicalKey = next;
  }

  if (visitedOrder.length > 0) {
    for (const alias of visitedOrder) {
      aliases.set(alias, canonicalKey);
    }
  }

  return canonicalKey;
}

export function recordTopicRenameAlias(params: {
  aliasesByStream: Map<string, Map<string, string>>;
  stream: string;
  fromTopic: string;
  toTopic: string;
}): boolean {
  const fromTopic = normalizeTopic(params.fromTopic);
  const toTopic = normalizeTopic(params.toTopic);
  if (!fromTopic || !toTopic) {
    return false;
  }

  const fromCanonicalKey = resolveCanonicalTopicSessionKey({
    aliasesByStream: params.aliasesByStream,
    stream: params.stream,
    topic: fromTopic,
  });
  const toCanonicalKey = resolveCanonicalTopicSessionKey({
    aliasesByStream: params.aliasesByStream,
    stream: params.stream,
    topic: toTopic,
  });

  if (fromCanonicalKey === toCanonicalKey) {
    return false;
  }

  let aliases = params.aliasesByStream.get(params.stream);
  if (!aliases) {
    aliases = new Map<string, string>();
    params.aliasesByStream.set(params.stream, aliases);
  }

  aliases.set(toCanonicalKey, fromCanonicalKey);
  return true;
}

export function extractZulipTopicDirective(text: string): { topic?: string; text: string } {
  const raw = text ?? "";
  // Allow an agent to create/switch topics by prefixing a reply with:
  // [[zulip_topic: <topic>]]
  const match = /^\s*\[\[zulip_topic:\s*([^\]]+)\]\]\s*\n?/i.exec(raw);
  if (!match) {
    return { text: raw };
  }
  const topic = normalizeTopic(match[1]) || undefined;
  const nextText = raw.slice(match[0].length).trimStart();
  if (!topic) {
    return { text: nextText };
  }
  // Keep topics reasonably short (UI-friendly).
  const truncated = topic.length > 60 ? topic.slice(0, 60).trim() : topic;
  return { topic: truncated || topic, text: nextText };
}
