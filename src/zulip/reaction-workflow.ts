import type { ResolvedZulipReactions, ZulipReactionWorkflowStage } from "./accounts.js";
import type { ZulipAuth } from "./client.js";
import { addZulipReaction, removeZulipReaction } from "./reactions.js";

export async function bestEffortReaction(params: {
  auth: ZulipAuth;
  messageId: number;
  op: "add" | "remove";
  emojiName: string;
  log?: (message: string) => void;
  abortSignal?: AbortSignal;
}) {
  const emojiName = params.emojiName;
  if (!emojiName) {
    return;
  }
  try {
    if (params.op === "add") {
      await addZulipReaction({
        auth: params.auth,
        messageId: params.messageId,
        emojiName,
        abortSignal: params.abortSignal,
        log: params.log,
      });
      return;
    }
    await removeZulipReaction({
      auth: params.auth,
      messageId: params.messageId,
      emojiName,
      abortSignal: params.abortSignal,
    });
  } catch (err) {
    params.log?.(`[zulip] reaction ${params.op} ${emojiName} failed: ${String(err)}`);
  }
}

export type ReactionTransitionController = {
  transition: (
    stage: ZulipReactionWorkflowStage,
    options?: { abortSignal?: AbortSignal; force?: boolean },
  ) => Promise<void>;
};

export function resolveStageEmoji(params: {
  reactions: ResolvedZulipReactions;
  stage: ZulipReactionWorkflowStage;
}): string {
  if (params.reactions.workflow.enabled) {
    const stageEmoji = params.reactions.workflow.stages[params.stage];
    return stageEmoji ?? "";
  }
  switch (params.stage) {
    case "queued":
    case "processing":
    case "toolRunning":
    case "retrying":
      return params.reactions.onStart;
    case "success":
      return params.reactions.onSuccess;
    case "partialSuccess":
    case "failure":
      return params.reactions.onFailure;
    default:
      return "";
  }
}

export function createReactionTransitionController(params: {
  auth: ZulipAuth;
  messageId: number;
  reactions: ResolvedZulipReactions;
  log?: (message: string) => void;
  now?: () => number;
}): ReactionTransitionController {
  const now = params.now ?? (() => Date.now());
  let activeEmoji = "";
  let activeStage: ZulipReactionWorkflowStage | null = null;
  let lastTransitionAt = 0;

  return {
    transition: async (stage, options) => {
      const emojiName = resolveStageEmoji({ reactions: params.reactions, stage });
      const force = options?.force === true;
      const workflow = params.reactions.workflow;

      if (workflow.enabled && !force) {
        if (activeStage === stage) {
          return;
        }
        if (workflow.minTransitionMs > 0 && lastTransitionAt > 0) {
          const elapsed = now() - lastTransitionAt;
          if (elapsed < workflow.minTransitionMs) {
            return;
          }
        }
      }

      if (!emojiName) {
        activeStage = stage;
        if (force) {
          lastTransitionAt = now();
        }
        return;
      }

      if (
        workflow.enabled &&
        workflow.replaceStageReaction &&
        activeEmoji &&
        activeEmoji !== emojiName
      ) {
        await bestEffortReaction({
          auth: params.auth,
          messageId: params.messageId,
          op: "remove",
          emojiName: activeEmoji,
          log: params.log,
          abortSignal: options?.abortSignal,
        });
      }

      if (activeEmoji !== emojiName) {
        await bestEffortReaction({
          auth: params.auth,
          messageId: params.messageId,
          op: "add",
          emojiName,
          log: params.log,
          abortSignal: options?.abortSignal,
        });
        activeEmoji = emojiName;
      }

      activeStage = stage;
      lastTransitionAt = now();
    },
  };
}

export function withWorkflowReactionStages<
  T extends {
    sendToolResult: (...args: unknown[]) => unknown;
    sendBlockReply: (...args: unknown[]) => unknown;
    sendFinalReply: (...args: unknown[]) => unknown;
  },
>(
  dispatcher: T,
  reactions: ResolvedZulipReactions,
  controller: ReactionTransitionController,
  abortSignal?: AbortSignal,
): T {
  return {
    ...dispatcher,
    sendToolResult: (...args: unknown[]) => {
      if (reactions.workflow.stages.toolRunning) {
        void controller.transition("toolRunning", { abortSignal });
      }
      return dispatcher.sendToolResult(...args);
    },
    sendBlockReply: (...args: unknown[]) => {
      if (reactions.workflow.stages.processing) {
        void controller.transition("processing", { abortSignal });
      }
      return dispatcher.sendBlockReply(...args);
    },
    sendFinalReply: (...args: unknown[]) => {
      if (reactions.workflow.stages.processing) {
        void controller.transition("processing", { abortSignal });
      }
      return dispatcher.sendFinalReply(...args);
    },
  };
}
