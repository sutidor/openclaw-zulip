import type { OpenClawConfig, ReplyPayload } from "openclaw/plugin-sdk";
import { getZulipRuntime } from "../runtime.js";
import type { ResolvedZulipAccount } from "./accounts.js";
import type { ZulipAuth } from "./client.js";
import { sendZulipStreamMessage } from "./send.js";
import { extractZulipTopicDirective } from "./topic-rename.js";
import { resolveOutboundMedia, uploadZulipFile } from "./uploads.js";

export async function deliverReply(params: {
  account: ResolvedZulipAccount;
  auth: ZulipAuth;
  stream: string;
  topic: string;
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  abortSignal?: AbortSignal;
}) {
  const core = getZulipRuntime();
  const logger = core.logging.getChildLogger({ channel: "zulip" });

  const topicDirective = extractZulipTopicDirective(params.payload.text ?? "");
  const topic = topicDirective.topic ?? params.topic;
  const text = topicDirective.text;
  const mediaUrls = (params.payload.mediaUrls ?? []).filter(Boolean);
  const mediaUrl = params.payload.mediaUrl?.trim();
  if (mediaUrl) {
    mediaUrls.unshift(mediaUrl);
  }

  const sendTextChunks = async (value: string) => {
    const chunks = core.channel.text.chunkMarkdownText(value, params.account.textChunkLimit);
    for (const chunk of chunks.length > 0 ? chunks : [value]) {
      if (!chunk) {
        continue;
      }
      const response = await sendZulipStreamMessage({
        auth: params.auth,
        stream: params.stream,
        topic,
        content: chunk,
        abortSignal: params.abortSignal,
      });
      // Delivery receipt verification: check message ID in response
      if (!response || typeof response.id !== "number") {
        logger.warn(`[zulip] sendZulipStreamMessage returned invalid or missing message ID`);
      }
    }
  };

  const trimmedText = text.trim();
  if (!trimmedText && mediaUrls.length === 0) {
    logger.debug(`[zulip] deliverReply: empty response (no text, no media) — skipping`);
    return;
  }
  if (mediaUrls.length === 0) {
    await sendTextChunks(text);
    return;
  }

  // Match core outbound behavior: treat text as a caption for the first media item.
  // If the caption is very long, send it as text chunks first to avoid exceeding limits.
  let caption = trimmedText;
  if (caption.length > params.account.textChunkLimit) {
    await sendTextChunks(text);
    caption = "";
  }

  for (const source of mediaUrls) {
    const resolved = await resolveOutboundMedia({
      cfg: params.cfg,
      accountId: params.account.accountId,
      mediaUrl: source,
    });
    const uploadedUrl = await uploadZulipFile({
      auth: params.auth,
      buffer: resolved.buffer,
      contentType: resolved.contentType,
      filename: resolved.filename ?? "attachment",
      abortSignal: params.abortSignal,
    });
    const content = caption ? `${caption}\n\n${uploadedUrl}` : uploadedUrl;
    const response = await sendZulipStreamMessage({
      auth: params.auth,
      stream: params.stream,
      topic,
      content,
      abortSignal: params.abortSignal,
    });
    // Delivery receipt verification: check message ID in response
    if (!response || typeof response.id !== "number") {
      logger.warn(`[zulip] sendZulipStreamMessage returned invalid or missing message ID`);
    }
    caption = "";
  }
}
