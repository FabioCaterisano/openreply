import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { emitEvent } from "@/lib/events/emit";

describe("emitEvent", () => {
  beforeEach(() => {
    process.env.OUTBOUND_WEBHOOK_URL = "https://n8n.example/webhook/openreply";
    process.env.OUTBOUND_WEBHOOK_SECRET = "s3cret";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts a signed JSON body", async () => {
    await emitEvent("comment.matched", { commenterId: "u1", dropNumber: 27 });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://n8n.example/webhook/openreply");
    const body = init.body as string;
    const expected = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(init.headers["X-Signature"]).toBe(expected);
    const parsed = JSON.parse(body);
    expect(parsed.name).toBe("comment.matched");
    expect(parsed.payload.dropNumber).toBe(27);
  });

  it("is a no-op without a URL and never throws on failure", async () => {
    delete process.env.OUTBOUND_WEBHOOK_URL;
    await emitEvent("followup.sent", {});
    expect(fetch).not.toHaveBeenCalled();
    process.env.OUTBOUND_WEBHOOK_URL = "https://n8n.example/webhook/openreply";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    await expect(emitEvent("followup.sent", {})).resolves.toBeUndefined();
  });
});
