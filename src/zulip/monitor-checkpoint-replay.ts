import type { MonitorContext, ZulipEventMessage } from "./monitor-types.js";
import type { ZulipInFlightCheckpoint } from "./inflight-checkpoints.js";
import {
  clearZulipInFlightCheckpoint,
  isZulipCheckpointStale,
  loadZulipInFlightCheckpoints,
  markZulipCheckpointFailure,
  writeZulipInFlightCheckpoint,
  ZULIP_INFLIGHT_MAX_RETRY_COUNT,
} from "./inflight-checkpoints.js";
import { ZULIP_RECOVERY_NOTICE } from "./constants.js";
import { sendZulipStreamMessage } from "./send.js";

export async function replayPendingCheckpoints(
  mctx: MonitorContext,
  handleMessage: (msg: ZulipEventMessage, opts?: { recoveryCheckpoint?: ZulipInFlightCheckpoint }) => Promise<void>,
  resumedCheckpointIds: Set<string>,
): Promise<void> {
  const { account, auth, logger, runtime, abortSignal } = mctx;

  const checkpoints = await loadZulipInFlightCheckpoints({ accountId: account.accountId });
  for (const checkpoint of checkpoints) {
    if (resumedCheckpointIds.has(checkpoint.checkpointId)) {
      continue;
    }
    resumedCheckpointIds.add(checkpoint.checkpointId);

    if (checkpoint.retryCount >= ZULIP_INFLIGHT_MAX_RETRY_COUNT) {
      logger.warn(
        `[zulip:${account.accountId}] dropping exhausted in-flight checkpoint ${checkpoint.checkpointId} (retryCount=${checkpoint.retryCount})`,
      );
      await clearZulipInFlightCheckpoint({ checkpointId: checkpoint.checkpointId }).catch(
        () => undefined,
      );
      continue;
    }

    if (isZulipCheckpointStale({ checkpoint })) {
      logger.warn(
        `[zulip:${account.accountId}] skipping stale in-flight checkpoint ${checkpoint.checkpointId}`,
      );
      await clearZulipInFlightCheckpoint({ checkpointId: checkpoint.checkpointId }).catch(
        () => undefined,
      );
      continue;
    }

    await sendZulipStreamMessage({
      auth,
      stream: checkpoint.stream,
      topic: checkpoint.topic,
      content: ZULIP_RECOVERY_NOTICE,
      abortSignal,
    }).catch((err: unknown) => {
      logger.warn(
        `[zulip:${account.accountId}] failed to send recovery notice for ${checkpoint.checkpointId}: ${String(err)}`,
      );
    });

    const syntheticMessage: ZulipEventMessage = {
      id: checkpoint.messageId,
      type: "stream",
      sender_id: Number(checkpoint.senderId) || 0,
      sender_full_name: checkpoint.senderName,
      sender_email: checkpoint.senderEmail,
      display_recipient: checkpoint.stream,
      stream_id: checkpoint.streamId,
      subject: checkpoint.topic,
      content: checkpoint.cleanedContent,
      timestamp:
        typeof checkpoint.timestampMs === "number"
          ? Math.floor(checkpoint.timestampMs / 1000)
          : undefined,
    };

    try {
      await handleMessage(syntheticMessage, { recoveryCheckpoint: checkpoint });
    } catch (err) {
      runtime.error?.(`[zulip:${account.accountId}] recovery replay failed for ${checkpoint.checkpointId}: ${String(err)}`);
      const failedCheckpoint = markZulipCheckpointFailure({ checkpoint, error: err });
      await writeZulipInFlightCheckpoint({ checkpoint: failedCheckpoint }).catch(
        () => undefined,
      );
    }
  }
}
