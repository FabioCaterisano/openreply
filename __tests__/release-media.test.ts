import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const { account, page, context, resolve } = vi.hoisted(() => ({ account: vi.fn(), page: vi.fn(), context: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { instagramAccount: { findUnique: account } } }));
vi.mock("@/lib/instagram/provider", () => ({ getUserMediaPage: page, createInstagramContext: context }));
vi.mock("@/lib/drops/resolve", () => ({ resolveDrop: resolve }));
import { GET as mediaGET } from "@/app/api/internal/release/media/route";
import { GET as resolveGET } from "@/app/api/internal/release/resolve/route";

function request(path = "/media", authorization = "Bearer private-service-key") {
  return new Request("https://reply.catno.ai/api/internal/release" + path, { headers: { authorization } });
}
beforeEach(() => {
  vi.stubEnv("CATNO_RELEASE_SECRET", "private-service-key");
  vi.stubEnv("CATNO_RELEASE_INSTAGRAM_ACCOUNT_ID", "own_ig");
  vi.clearAllMocks();
  account.mockResolvedValue({ id: "connection", instagramId: "own_ig", provider: "META" });
  context.mockResolvedValue({ provider: "META", accessToken: "NEVER_EXPOSE" });
  page.mockResolvedValue({ data: [{ id: "reel1", caption: "#catnodrop27", permalink: "https://instagram.com/reel/POST/", timestamp: "2026-09-13T12:00:00Z", thumbnail_url: "https://cdn.example/image.jpg", media_url: "SECRET_VIDEO_URL", media_type: "VIDEO", media_product_type: "REELS" }], after: "native-cursor" });
  resolve.mockResolvedValue({ dropNumber: 27, slug: "drop", handoutUrl: "https://decks.catno.ai/drop/", matchedBy: "permalink" });
});
afterEach(() => vi.unstubAllEnvs());

describe("internal release media API", () => {
  it.each(["", "Bearer wrong", "Bearer undefined"])("rejects unauthorized service credentials %s", async auth => {
    expect((await mediaGET(request("/media", auth))).status).toBe(401);
    expect(account).not.toHaveBeenCalled();
  });
  it("rejects missing server credentials", async () => {
    vi.stubEnv("CATNO_RELEASE_SECRET", "");
    expect((await mediaGET(request())).status).toBe(401);
  });
  it("fails closed when the fixed account is absent or unsupported", async () => {
    account.mockResolvedValueOnce(null);
    expect((await mediaGET(request())).status).toBe(503);
    account.mockResolvedValueOnce({ id: "connection", instagramId: "own_ig", provider: "ZERNIO" });
    expect((await mediaGET(request())).status).toBe(409);
    expect(page).not.toHaveBeenCalled();
  });
  it("binds the own account, redacts media tokens, and round-trips the opaque cursor", async () => {
    const first = await (await mediaGET(request("/media?accountId=OTHER"))).json();
    expect(account).toHaveBeenCalledWith({ where: { instagramId: "own_ig" } });
    expect(first).toMatchObject({ accountId: "own_ig", connectionId: "connection", pagination: { hasMore: true } });
    expect(JSON.stringify(first)).not.toMatch(/NEVER_EXPOSE|SECRET_VIDEO_URL|access_token|paging.next/);
    expect(first.data[0].thumbnail_url).toBe("https://cdn.example/image.jpg");
    page.mockResolvedValueOnce({ data: [], after: null });
    const second = await (await mediaGET(request("/media?cursor=" + encodeURIComponent(first.pagination.cursor)))).json();
    expect(page).toHaveBeenLastCalledWith({ context: { provider: "META", accessToken: "NEVER_EXPOSE" }, after: "native-cursor", limit: 100 });
    expect(second.pagination).toEqual({ hasMore: false, cursor: null });
  });
  it("rejects tampered and cross-account cursors", async () => {
    const first = await (await mediaGET(request())).json();
    expect((await mediaGET(request("/media?cursor=" + first.pagination.cursor + "x"))).status).toBe(400);
    account.mockResolvedValue({ id: "different", instagramId: "another-own", provider: "META" });
    expect((await mediaGET(request("/media?cursor=" + first.pagination.cursor))).status).toBe(400);
  });
  it("returns failure with no partial completion when a later page fails", async () => {
    const first = await (await mediaGET(request())).json();
    page.mockRejectedValueOnce(new Error("URL_WITH_SECRET_TOKEN"));
    const response = await mediaGET(request("/media?cursor=" + first.pagination.cursor));
    expect(response.status).toBe(502);
    const failure = await response.json();
    expect(failure).not.toHaveProperty("data");
    expect(JSON.stringify(failure)).not.toMatch(/URL_WITH_SECRET_TOKEN|pagination|hasMore/);
  });
  it.each(["0", "101", "1.5", "abc"])("validates page limit %s", async limit => {
    expect((await mediaGET(request("/media?limit=" + limit))).status).toBe(400);
  });
});

describe("internal strict resolver readback", () => {
  it("forces catalog refresh and strict permalink-number matching", async () => {
    const response = await resolveGET(request("/resolve?permalink=https://instagram.com/reel/POST/&dropNumber=27&forceRefresh=true"));
    expect(await response.json()).toMatchObject({ ready: true, accountId: "own_ig", data: { dropNumber: 27 } });
    expect(resolve).toHaveBeenCalledWith({ permalink: "https://instagram.com/reel/POST/", expectedDropNumber: 27, commentText: "", forceRefresh: true, strict: true });
  });
  it("reports not ready and upstream failure distinctly", async () => {
    resolve.mockResolvedValueOnce(null);
    const query = request("/resolve?permalink=https://instagram.com/reel/POST/&dropNumber=27&forceRefresh=true");
    expect(await (await resolveGET(query)).json()).toMatchObject({ ready: false, data: null });
    resolve.mockRejectedValueOnce(new Error("offline"));
    expect((await resolveGET(query)).status).toBe(502);
  });
});
