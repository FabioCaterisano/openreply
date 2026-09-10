import { createHmac } from "node:crypto";

export type OutboundEventName =
  | "comment.matched"
  | "follow_prompt.sent"
  | "link.delivered"
  | "followup.sent"
  | "link.clicked";

const TIMEOUT_MS = 5000;

// Warn about a missing secret once per process, not once per event.
let warnedMissingSecret = false;

/**
 * Fire-and-forget event export to n8n. Signed with HMAC-SHA256 over the raw
 * body. Never throws and never rejects: a dead or misconfigured n8n must not
 * block a DM send, and call sites discard the promise with `void`.
 */
export async function emitEvent(
  name: OutboundEventName,
  payload: Record<string, unknown>
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = process.env.OUTBOUND_WEBHOOK_URL;
    if (!url) return;
    const secret = process.env.OUTBOUND_WEBHOOK_SECRET ?? "";
    if (!secret && !warnedMissingSecret) {
      warnedMissingSecret = true;
      console.warn("[events] OUTBOUND_WEBHOOK_SECRET missing, signing with empty key");
    }
    const body = JSON.stringify({ name, at: new Date().toISOString(), payload });
    const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": signature },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn("[events] webhook rejected:", name, response.status);
    }
  } catch (error) {
    console.log("[events] emit failed:", name, error instanceof Error ? error.message : error);
  } finally {
    clearTimeout(timer);
  }
}
