import type { ReplyPayload } from "openclaw/plugin-sdk";

/**
 * Shared email-prefix → Zulip display name cache.
 * Populated by each monitor at startup; read by action handlers.
 */
let cache = new Map<string, string>();

export function updateMentionDisplayNames(names: Map<string, string>): void {
  for (const [key, value] of names) {
    cache.set(key, value);
  }
}

export function getMentionDisplayNames(): Map<string, string> {
  return cache;
}

/**
 * Normalize @mentions in a plain text string. Replaces:
 *   - "@emailPrefix" (plain text) → "@**Display Name**" (Zulip mention)
 *   - "@**emailPrefix**" (bold but wrong name) → "@**Display Name**"
 * Only replaces known email prefixes from the displayNames map.
 */
export function normalizeMentionText(
  text: string,
  displayNames: Map<string, string>,
): string {
  if (!text || displayNames.size === 0) return text;
  let result = text;
  for (const [prefix, displayName] of displayNames) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Replace @**emailPrefix** → @**Display Name**
    result = result.replace(
      new RegExp(`@\\*\\*${escaped}\\*\\*`, "gi"),
      `@**${displayName}**`,
    );
    // Replace plain @emailPrefix → @**Display Name** (word boundary, not inside **)
    result = result.replace(
      new RegExp(`(?<![*])@${escaped}(?![*])\\b`, "gi"),
      `@**${displayName}**`,
    );
  }
  return result;
}

/**
 * Normalize outgoing @mentions in a reply payload.
 * Wrapper around normalizeMentionText for ReplyPayload objects.
 */
export function normalizeMentions(
  payload: ReplyPayload,
  displayNames: Map<string, string>,
): ReplyPayload {
  if (!payload.text || displayNames.size === 0) return payload;
  const text = normalizeMentionText(payload.text, displayNames);
  if (text === payload.text) return payload;
  return { ...payload, text };
}
