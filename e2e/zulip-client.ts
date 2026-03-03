/**
 * Minimal Zulip API client for E2E testing.
 * Plain HTTP — no SDK dependency.
 */

export type ZulipMessage = {
  id: number;
  sender_email: string;
  sender_full_name: string;
  content: string;
  timestamp: number;
  reactions: ZulipReaction[];
};

export type ZulipReaction = {
  emoji_name: string;
  user_id: number;
  user?: { email?: string; user_id?: number };
};

export type ZulipClient = {
  /** Send a message to a stream/topic. Returns the message ID. */
  sendMessage(stream: string, topic: string, content: string): Promise<number>;
  /** Fetch messages from a stream/topic. */
  getMessages(params: {
    stream: string;
    topic: string;
    anchor?: "newest" | "oldest" | number;
    numBefore?: number;
    numAfter?: number;
  }): Promise<ZulipMessage[]>;
  /** Add an emoji reaction to a message. */
  addReaction(messageId: number, emojiName: string): Promise<void>;
  /** Get a single message by ID (includes reactions). */
  getMessage(messageId: number): Promise<ZulipMessage>;
  /** Get a user by email. Returns user_id, email, full_name. */
  getUserByEmail(email: string): Promise<{ user_id: number; email: string; full_name: string }>;
  /** Get the current user's identity. */
  getMe(): Promise<{ user_id: number; email: string; full_name: string }>;
};

export function createZulipClient(params: {
  baseUrl: string;
  email: string;
  apiKey: string;
}): ZulipClient {
  const { baseUrl, email, apiKey } = params;
  const auth = Buffer.from(`${email}:${apiKey}`).toString("base64");

  async function request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const url = `${baseUrl.replace(/\/+$/, "")}/api/v1${path}`;
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
    };

    let fetchInit: RequestInit;
    if (body && method !== "GET") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        form.set(k, typeof v === "string" ? v : JSON.stringify(v));
      }
      fetchInit = { method, headers, body: form.toString() };
    } else {
      fetchInit = { method, headers };
    }

    const res = await fetch(url, fetchInit);
    const json = (await res.json()) as Record<string, unknown>;
    if (json.result !== "success") {
      throw new Error(
        `Zulip API error: ${path} → ${json.msg ?? JSON.stringify(json)}`,
      );
    }
    return json;
  }

  return {
    async sendMessage(stream, topic, content) {
      const json = (await request("POST", "/messages", {
        type: "stream",
        to: stream,
        topic,
        content,
      })) as { id: number };
      return json.id;
    },

    async getMessages({ stream, topic, anchor, numBefore, numAfter }) {
      const narrow = JSON.stringify([
        ["channel", stream],
        ["topic", topic],
      ]);
      const params = new URLSearchParams({
        narrow,
        anchor: String(anchor ?? "newest"),
        num_before: String(numBefore ?? 50),
        num_after: String(numAfter ?? 0),
        apply_markdown: "false",
      });
      const url = `/messages?${params}`;
      const json = (await request("GET", url)) as {
        messages: ZulipMessage[];
      };
      return json.messages;
    },

    async addReaction(messageId, emojiName) {
      await request("POST", `/messages/${messageId}/reactions`, {
        emoji_name: emojiName,
      });
    },

    async getMessage(messageId) {
      const json = (await request(
        "GET",
        `/messages/${messageId}`,
      )) as { message: ZulipMessage };
      return json.message;
    },

    async getUserByEmail(email) {
      const json = (await request(
        "GET",
        `/users/${encodeURIComponent(email)}`,
      )) as { user: { user_id: number; email: string; full_name: string } };
      return json.user;
    },

    async getMe() {
      const json = (await request("GET", "/users/me")) as {
        user_id: number;
        email: string;
        full_name: string;
      };
      return json;
    },
  };
}
