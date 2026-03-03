import type { MonitorContext, ZulipReactionEvent } from "./monitor-types.js";
import type { ReactionMessageContextTracker } from "./monitor-reaction-context.js";
import { dispatchSyntheticReactionContext } from "./monitor-reaction-context.js";
import { normalizeEmojiName } from "./normalize.js";
import { getReactionButtonSession, handleReactionEvent } from "./reaction-buttons.js";
import { resolveCanonicalTopicSessionKey } from "./topic-rename.js";

export async function handleReaction(
  mctx: MonitorContext,
  reactionEvent: ZulipReactionEvent,
  reactionTracker: ReactionMessageContextTracker,
): Promise<void> {
  const { account, cfg, core, logger, botUserId, topicAliasesByStream } = mctx;

  if (typeof reactionEvent.message_id !== "number") {
    return;
  }

  const result =
    reactionEvent.op === "add"
      ? handleReactionEvent({
          messageId: reactionEvent.message_id,
          emojiName: reactionEvent.emoji_name,
          userId: reactionEvent.user_id,
          botUserId,
        })
      : null;

  if (result) {
    logger.info(
      `[zulip:${account.accountId}] reaction button clicked: messageId=${result.messageId}, index=${result.selectedIndex}, value=${result.selectedOption?.value}`,
    );

    core.channel.activity.record({
      channel: "zulip",
      accountId: account.accountId,
      direction: "inbound",
      at: Date.now(),
    });

    const buttonSession = getReactionButtonSession(result.messageId);
    const source = buttonSession
      ? { stream: buttonSession.stream, topic: buttonSession.topic }
      : await reactionTracker.resolve(reactionEvent);

    if (!source?.stream || !source.topic) {
      logger.debug?.(
        `[zulip:${account.accountId}] reaction button ignored: unresolved source for message ${result.messageId}`,
      );
      return;
    }

    const buttonPayload = {
      type: "reaction_button_click" as const,
      messageId: result.messageId,
      selectedIndex: result.selectedIndex,
      selectedOption: result.selectedOption,
      userId: reactionEvent.user_id,
      userName: reactionEvent.user?.full_name ?? String(reactionEvent.user_id),
    };

    dispatchSyntheticReactionContext(mctx, {
      stream: source.stream,
      topic: source.topic,
      body: `[zulip reaction button click: messageId=${result.messageId}, option="${result.selectedOption?.label}" (${result.selectedOption?.value})]`,
      rawBody: JSON.stringify(buttonPayload),
      commandBody: `reaction_button_${result.selectedIndex}`,
      sessionKeySuffix: String(result.messageId),
      userId: reactionEvent.user_id,
      userName: reactionEvent.user?.full_name ?? String(reactionEvent.user_id),
      messageSid: `reaction-button-${result.messageId}-${Date.now()}`,
      systemPrompt:
        "A user clicked a reaction button on a previous message. Respond to their selection.",
      errorLabel: "reaction button",
    });
    return;
  }

  if (!account.reactions.genericCallback.enabled) {
    return;
  }
  if (reactionEvent.user_id === botUserId) {
    return;
  }
  if (mctx.siblingBotUserIds.has(reactionEvent.user_id)) {
    return;
  }
  if (reactionEvent.op === "remove" && !account.reactions.genericCallback.includeRemoveOps) {
    return;
  }

  // Emoji allowlist filter: if configured, only allow specific emojis
  const { allowedEmojis } = account.reactions.genericCallback;
  if (
    allowedEmojis.length > 0 &&
    !allowedEmojis.includes(normalizeEmojiName(reactionEvent.emoji_name))
  ) {
    return;
  }

  const source = await reactionTracker.resolve(reactionEvent);
  if (!source?.stream || !source.topic) {
    logger.debug?.(
      `[zulip:${account.accountId}] generic reaction ignored: unresolved source for message ${reactionEvent.message_id}`,
    );
    return;
  }

  // Only handle reactions on messages sent by THIS bot account
  if (typeof source.senderId === "number" && source.senderId !== botUserId) {
    return;
  }

  if (account.streams.length > 0 && !account.streams.includes(source.stream)) {
    return;
  }

  core.channel.activity.record({
    channel: "zulip",
    accountId: account.accountId,
    direction: "inbound",
    at: Date.now(),
  });

  const normalizedEmojiToken = reactionTracker.toCommandToken(reactionEvent.emoji_name);
  const genericPayload = {
    type: "reaction_event" as const,
    op: reactionEvent.op,
    emojiName: reactionEvent.emoji_name,
    emojiCode: reactionEvent.emoji_code,
    messageId: reactionEvent.message_id,
    userId: reactionEvent.user_id,
    userName: reactionEvent.user?.full_name ?? String(reactionEvent.user_id),
  };

  // Route to the main topic session so the bot has conversation context
  const reactionRoute = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "zulip",
    accountId: account.accountId,
    peer: { kind: "channel" as const, id: source.stream },
  });
  const canonicalReactionTopicKey = resolveCanonicalTopicSessionKey({
    aliasesByStream: topicAliasesByStream,
    stream: source.stream,
    topic: source.topic,
  });
  const topicSessionKey = `${reactionRoute.sessionKey}:topic:${canonicalReactionTopicKey}`;

  const reactorName = reactionEvent.user?.full_name ?? String(reactionEvent.user_id);

  dispatchSyntheticReactionContext(mctx, {
    stream: source.stream,
    topic: source.topic,
    body: `[zulip reaction ${reactionEvent.op}: emoji=":${reactionEvent.emoji_name}:" by ${reactorName} on message ${reactionEvent.message_id}]`,
    rawBody: JSON.stringify(genericPayload),
    commandBody: `reaction_${reactionEvent.op}_${normalizedEmojiToken}`,
    sessionKeySuffix: `${reactionEvent.message_id}:${reactionEvent.op}:${normalizedEmojiToken}`,
    sessionKeyOverride: topicSessionKey,
    streamId: source.streamId ?? reactionEvent.message?.stream_id,
    agentId: reactionRoute.agentId,
    userId: reactionEvent.user_id,
    userName: reactorName,
    messageSid: `reaction-generic-${reactionEvent.message_id}-${Date.now()}`,
    systemPrompt: buildReactionSystemPrompt(
      reactionEvent.emoji_name,
      account.reactions.genericCallback.emojiSemantics,
    ),
    errorLabel: "generic reaction",
  });
}

function buildReactionSystemPrompt(
  emojiName: string,
  semantics: Record<string, string>,
): string {
  const lines = Object.entries(semantics).map(
    ([name, meaning]) => `- :${name}: — ${meaning}`,
  );
  return (
    `The user reacted with :${emojiName}: to your previous message. ` +
    "Emoji action semantics:\n" +
    lines.join("\n") +
    "\n\n" +
    "If the message contained action items, a todo list, or a proposal, " +
    "apply the emoji's meaning and respond with the actions taken."
  );
}
