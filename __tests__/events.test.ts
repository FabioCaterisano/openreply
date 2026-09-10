import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { emitEvent } from "@/lib/events/emit";

const originalUrl = process.env.OUTBOUND_WEBHOOK_URL;
const originalSecret = process.env.OUTBOUND_WEBHOOK_SECRET;

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("emitEvent", () => {
  beforeEach(() => {
    process.env.OUTBOUND_WEBHOOK_URL = "https://n8n.example/webhook/openreply";
    process.env.OUTBOUND_WEBHOOK_SECRET = "s3cret";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreEnv("OUTBOUND_WEBHOOK_URL", originalUrl);
    restoreEnv("OUTBOUND_WEBHOOK_SECRET", originalSecret);
  });

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

  it("warns on a rejected webhook and still resolves", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));
    await expect(emitEvent("link.clicked", {})).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(" ")).toContain("webhook rejected");
    expect(warn.mock.calls[0].join(" ")).toContain("401");
  });

  it("still posts without a secret and warns about it once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.OUTBOUND_WEBHOOK_SECRET;
    await emitEvent("followup.sent", {});
    await emitEvent("followup.sent", {});
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const expected = "sha256=" + createHmac("sha256", "").update(init.body).digest("hex");
    expect(init.headers["X-Signature"]).toBe(expected);
    const secretWarnings = warn.mock.calls.filter((c) =>
      c.join(" ").includes("OUTBOUND_WEBHOOK_SECRET missing")
    );
    expect(secretWarnings).toHaveLength(1);
  });
});
