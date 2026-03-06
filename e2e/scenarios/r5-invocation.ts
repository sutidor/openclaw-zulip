/**
 * Scenario R5: Bot @mentions another bot → that bot responds.
 *
 * Parties: sim-user, coordinator (BotA), specialist (BotB)
 *
 * Success criterion: A message (with NO @mention) triggers the
 * coordinator to @mention the specialist. The specialist responds
 * visibly in the stream.
 *
 * Expected behavior per bot:
 * - Coordinator (BotA): receives the unmentioned message (R1), decides
 *   via LLM to delegate, replies with text that @mentions the
 *   specialist.
 * - Specialist (BotB): sees the coordinator's @mention (sibling bot
 *   message with @mention passes the bot-to-bot filter per R5),
 *   processes it as a normal mention, and replies with text in the
 *   same topic.
 *
 * Note: This scenario depends on the coordinator's LLM deciding to
 * delegate. The prompt is designed to encourage delegation, but
 * LLM behavior is non-deterministic. If the coordinator doesn't
 * delegate, the scenario fails.
 *
 * IMPORTANT: The trigger message must NOT @mention the specialist
 * directly — that would trigger R2 routing (specialist handles,
 * coordinator defers), preventing the coordinator from replying.
 */

import type { E2EConfig } from "../config.js";
import {
  type ZulipClient,
  type ScenarioResult,
  uniqueTopic,
  waitForMessages,
  sleep,
  isFrom,
} from "@openclaw/e2e";

export async function run(
  client: ZulipClient,
  config: E2EConfig,
): Promise<ScenarioResult> {
  const name = "R5-bot-invocation";
  const start = Date.now();
  const topic = uniqueTopic("r5");

  try {
    // Send an unmentioned message that encourages the coordinator to
    // delegate to the specialist via @mention. Must NOT include any
    // @**Name** syntax — that triggers R2 routing (specialist handles,
    // coordinator defers). Use plain text name + instructions instead.
    const specialistPrefix = config.specialistEmail.split("@")[0];
    await client.sendMessage(
      config.stream,
      topic,
      `Please ask ${specialistPrefix} what 2+2 is. Mention them using Zulip mention syntax in your reply so they see it.`,
    );

    // Wait for coordinator to reply (it should @mention the specialist)
    const coordMessages = await waitForMessages({
      client,
      config,
      stream: config.stream,
      topic,
      predicate: (msg) => isFrom(msg, config.coordinatorEmail),
      label: "coordinator reply",
    });

    // Check if coordinator's reply @mentions the specialist. Accept
    // multiple formats since LLMs may not know Zulip's exact syntax:
    //   @**📐 Amira**  — Zulip display name mention
    //   @**amira-bot** — Zulip email-prefix mention
    //   @amira-bot     — plain @mention (no bold markers)
    const coordContent = coordMessages[0].content;
    const mentionPatterns = [
      new RegExp(`@\\*\\*${config.specialistDisplayName}\\*\\*`),
      new RegExp(`@\\*\\*${specialistPrefix}\\*\\*`, "i"),
      new RegExp(`(?:^|\\s)@${specialistPrefix}(?:\\s|$|[,.:!?])`, "i"),
    ];
    const hasMention = mentionPatterns.some((p) => p.test(coordContent));
    if (!hasMention) {
      return {
        name,
        passed: false,
        error:
          `Coordinator did not @mention specialist (LLM did not delegate). ` +
          `Expected @mention of ${specialistPrefix} in reply. ` +
          `Got: ${coordContent.slice(0, 200)}`,
        durationMs: Date.now() - start,
      };
    }

    // Wait for specialist to respond to the @mention
    await sleep(config.pollIntervalMs);
    await waitForMessages({
      client,
      config,
      stream: config.stream,
      topic,
      predicate: (msg) => isFrom(msg, config.specialistEmail),
      label: "specialist reply to bot @mention",
    });

    return { name, passed: true, durationMs: Date.now() - start };
  } catch (err) {
    return {
      name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}
