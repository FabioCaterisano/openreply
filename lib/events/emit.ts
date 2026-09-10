import { createHmac } from "node:crypto";

export type OutboundEventName =
  | "comment.matched"
  | "follow_prompt.sent"
  | "link.delivered"
  | "followup.sent"
  | "link.clicked";

/**
 * Fire-and-forget event export to n8n. Signed with HMAC-SHA256 over the raw
 * body. Never throws: a dead n8n must not block a DM send.
 */
export async function emitEvent(
  name: OutboundEventName,
  payload: Record<string, unknown>
): Promise<void> {
  const url = process.env.OUTBOUND_WEBHOOK_URL;
  if (!url) return;
  const secret = process.env.OUTBOUND_WEBHOOK_SECRET ?? "";
  const body = JSON.stringify({ name, at: new Date().toISOString(), payload });
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": signature },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (error) {
    console.log("[events] emit failed:", name, error instanceof Error ? error.message : error);
  }
}
