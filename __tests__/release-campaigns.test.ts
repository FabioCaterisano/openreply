import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  account: vi.fn(), findMany: vi.fn(), create: vi.fn(), executeRaw: vi.fn(), transaction: vi.fn(),
  context: vi.fn(), media: vi.fn(), page: vi.fn(), resolve: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: {
  instagramAccount: { findUnique: m.account },
  automation: { findMany: m.findMany, create: m.create },
  dmLog: { updateMany: vi.fn() },
  $transaction: m.transaction,
} }));
vi.mock("@/lib/instagram/provider", () => ({ createInstagramContext: m.context, getMediaDetails: m.media, getUserMediaPage: m.page }));
vi.mock("@/lib/drops/resolve", () => ({ resolveDrop: m.resolve }));
import { GET as campaignsGET, POST as campaignsPOST } from "@/app/api/internal/release/campaigns/route";
import { POST as bindingsPOST } from "@/app/api/internal/release/bindings/route";
import { GET as mediaGET } from "@/app/api/internal/release/media/route";
import { GET as resolveGET } from "@/app/api/internal/release/resolve/route";

const CATNO = "Bearer catno-release-secret";
const KIBY = "Bearer kibybyte-release-secret-0123456789abcdef";
const ACCOUNTS: Record<string, object> = {
  catno_ig: { id: "catno_conn", workspaceId: "ws", instagramId: "catno_ig", provider: "META" },
  kiby_ig: { id: "kiby_conn", workspaceId: "ws", instagramId: "kiby_ig", provider: "META" },
};
const BODY = {
  accountId: "kiby_ig", mediaId: "18000000000000001", permalink: "https://www.instagram.com/reel/KIBY12/", hashtag: "#kibybyte12",
  keyword: "TV", handoutUrl: "https://handouts.kibybyte.de/012-tv-start/", dmMessage: "Hier ist deine Anleitung.", buttonLabel: "Anleitung öffnen",
};
type Stored = Record<string, unknown> & { trackedLinks: { destinationUrl: string }[] };
let stored: Stored[];

function stub(input: { data: { trackedLinks: { create: { destinationUrl: string }[] } } & Record<string, unknown> }): Stored {
  const { trackedLinks, ...rest } = input.data;
  return { id: `camp${stored.length + 1}`, createdAt: new Date("2026-10-30T12:00:00Z"), ...rest,
    trackedLinks: trackedLinks.create.map(l => ({ destinationUrl: l.destinationUrl })) } as Stored;
}
function post(body: unknown, authorization = KIBY) {
  return new Request("https://reply.catno.ai/api/internal/release/campaigns", { method: "POST", headers: { authorization }, body: JSON.stringify(body) });
}
function get(path: string, authorization = KIBY) {
  return new Request("https://reply.catno.ai/api/internal/release" + path, { headers: { authorization } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CATNO_RELEASE_SECRET", "catno-release-secret");
  vi.stubEnv("CATNO_RELEASE_INSTAGRAM_ACCOUNT_ID", "catno_ig");
  vi.stubEnv("KIBYBYTE_RELEASE_SECRET", "kibybyte-release-secret-0123456789abcdef");
  vi.stubEnv("KIBYBYTE_RELEASE_INSTAGRAM_ACCOUNT_ID", "kiby_ig");
  vi.stubGlobal("fetch", m.fetch);
  stored = [];
  m.account.mockImplementation(async ({ where }: { where: { instagramId: string } }) => ACCOUNTS[where.instagramId] ?? null);
  m.context.mockResolvedValue({ provider: "META", accessToken: "NEVER_EXPOSE" });
  m.media.mockResolvedValue({ id: BODY.mediaId, permalink: "https://www.instagram.com/reel/KIBY12/", caption: "TV einrichten. Kommentiere TV. #kibybyte12 #ki" });
  m.fetch.mockResolvedValue(new Response(null, { status: 200 }));
  m.page.mockResolvedValue({ data: [], after: null });
  // Evaluates the `OR` clauses like Prisma: a row matches when every field of one clause is equal.
  m.findMany.mockImplementation(async ({ where }: { where: { instagramAccountId: string; postId?: string; OR?: Record<string, unknown>[] } }) =>
    stored.filter(c => c.instagramAccountId === where.instagramAccountId
      && (where.postId === undefined || c.postId === where.postId)
      && (!where.OR || where.OR.some(clause => Object.entries(clause).every(([key, value]) => c[key] === value)))));
  m.create.mockImplementation(async (input: Parameters<typeof stub>[0]) => { const c = stub(input); stored.push(c); return c; });
  m.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ $executeRaw: m.executeRaw, automation: { findMany: m.findMany, create: m.create } }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("release identities are isolated", () => {
  it("KIbyByte token cannot use CATNO-only routes or touch the CATNO account", async () => {
    expect((await mediaGET(get("/media"))).status).toBe(403);
    expect((await resolveGET(get("/resolve?permalink=https://instagram.com/reel/POST/&dropNumber=27"))).status).toBe(403);
    const binding = new Request("https://reply.catno.ai/api/internal/release/bindings", { method: "POST", headers: { authorization: KIBY }, body: "{}" });
    expect((await bindingsPOST(binding)).status).toBe(403);
    expect(m.account).not.toHaveBeenCalled();
    const foreign = await campaignsPOST(post({ ...BODY, accountId: "catno_ig" }));
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ committed: false });
    expect(m.account).toHaveBeenCalledWith({ where: { instagramId: "kiby_ig" } });
    expect(m.account).not.toHaveBeenCalledWith({ where: { instagramId: "catno_ig" } });
    expect(m.media).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("CATNO token cannot create or read campaigns and keeps its own routes on its own account", async () => {
    expect((await campaignsPOST(post({ ...BODY, accountId: "catno_ig" }, CATNO))).status).toBe(403);
    expect((await campaignsGET(get("/campaigns?mediaId=1", CATNO))).status).toBe(403);
    expect(m.account).not.toHaveBeenCalled();
    const media = await mediaGET(get("/media", CATNO));
    expect(media.status).toBe(200);
    expect(await media.json()).toMatchObject({ accountId: "catno_ig", connectionId: "catno_conn" });
    expect(m.account).toHaveBeenCalledWith({ where: { instagramId: "catno_ig" } });
  });

  it("refuses unknown tokens and identities that share a secret or an account", async () => {
    expect((await campaignsPOST(post(BODY, "Bearer wrong"))).status).toBe(401);
    expect((await campaignsPOST(post(BODY, "Bearer undefined"))).status).toBe(401);
    vi.stubEnv("KIBYBYTE_RELEASE_SECRET", "catno-release-secret");
    expect((await mediaGET(get("/media", CATNO))).status).toBe(503);
    vi.stubEnv("KIBYBYTE_RELEASE_SECRET", "kibybyte-release-secret-0123456789abcdef");
    vi.stubEnv("KIBYBYTE_RELEASE_INSTAGRAM_ACCOUNT_ID", "catno_ig");
    expect((await campaignsPOST(post(BODY))).status).toBe(503);
    expect((await mediaGET(get("/media", CATNO))).status).toBe(503);
    expect(m.account).not.toHaveBeenCalled();
  });
});

describe("missing configuration", () => {
  it("returns 401 without a server secret and 503 without the account", async () => {
    vi.stubEnv("KIBYBYTE_RELEASE_SECRET", "");
    expect((await campaignsPOST(post(BODY))).status).toBe(401);
    vi.stubEnv("KIBYBYTE_RELEASE_SECRET", "kibybyte-release-secret-0123456789abcdef");
    vi.stubEnv("KIBYBYTE_RELEASE_INSTAGRAM_ACCOUNT_ID", "");
    const missing = await campaignsPOST(post(BODY));
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ success: false, committed: false });
    expect((await campaignsGET(get("/campaigns?mediaId=1"))).status).toBe(503);
    vi.stubEnv("KIBYBYTE_RELEASE_INSTAGRAM_ACCOUNT_ID", "kiby_not_connected");
    expect((await campaignsPOST(post(BODY))).status).toBe(503);
    expect(m.transaction).not.toHaveBeenCalled();
  });
});

describe("idempotent per-reel campaign", () => {
  it("creates once, returns the same campaign on repeat, and reads it back", async () => {
    const first = await campaignsPOST(post(BODY));
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created).toMatchObject({ success: true, committed: true, created: true, accountId: "kiby_ig", connectionId: "kiby_conn",
      data: { postId: BODY.mediaId, keywords: ["TV"], handoutUrls: [BODY.handoutUrl], buttonLabel: "Anleitung öffnen", isActive: true,
        matchAnyPost: false, matchAnyWord: false, dmTriggerEnabled: false, name: "KIbyByte #kibybyte12 · TV" } });
    expect(m.create.mock.calls[0][0].data).toMatchObject({ workspaceId: "ws", instagramAccountId: "kiby_conn", postUrl: BODY.permalink });
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
    expect(m.executeRaw.mock.calls[0].slice(1)).toEqual([`release-campaign:kiby_conn:${BODY.mediaId}`]);
    expect(JSON.stringify(created)).not.toContain("NEVER_EXPOSE");

    const again = await campaignsPOST(post(BODY));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, data: { id: created.data.id } });
    expect(m.create).toHaveBeenCalledTimes(1);

    const readback = await (await campaignsGET(get(`/campaigns?mediaId=${BODY.mediaId}`))).json();
    expect(readback).toMatchObject({ success: true, accountId: "kiby_ig", connectionId: "kiby_conn", data: [{ id: created.data.id }] });
    expect(m.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { instagramAccountId: "kiby_conn",
      OR: [{ postId: BODY.mediaId }, { isActive: true, matchAnyPost: true }, { isActive: true, pendingNextReel: true }] } }));
  });

  it.each([
    ["a different DM text", { dmMessage: "Andere Nachricht." }],
    ["a different keyword", { keyword: "TVX" }],
    ["a different handout", { handoutUrl: "https://handouts.kibybyte.de/012-other/" }],
  ])("answers 409 for %s on the same reel and changes nothing", async (_label, change) => {
    expect((await campaignsPOST(post(BODY))).status).toBe(201);
    const conflict = await campaignsPOST(post({ ...BODY, ...change }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ success: false, committed: false });
    expect(m.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an opening DM", { openingDmEnabled: true, openingDmMessage: "https://evil.example", openingDmButtonLabel: "Los" }],
    ["an opening DM text while disabled", { openingDmMessage: "https://evil.example" }],
    ["an opening DM button label", { openingDmButtonLabel: "Los" }],
    ["a follow gate", { requireFollow: true }],
    ["a follow prompt", { followPromptMessage: "Folge erst" }],
    ["a follow prompt button", { followPromptButtonLabel: "Gefolgt" }],
    ["a follow-up", { followUpEnabled: true, followUpMessage: "https://evil.example" }],
    ["a follow-up text while disabled", { followUpMessage: "Und?" }],
    ["a follow-up delay", { followUpDelayMinutes: 5 }],
    ["a public reply", { publicReplyEnabled: true }],
    ["a public reply text", { publicReplyMessage: "Schau in die DMs" }],
    ["public reply variants", { publicReplyMessages: ["Check DMs"] }],
    ["substring matching", { wholeWordMatch: false }],
    ["any-word matching", { matchAnyWord: true }],
    ["a DM trigger", { dmTriggerEnabled: true }],
    ["a second keyword", { keywords: ["TV", "FERNSEHER"] }],
    ["a deactivated campaign", { isActive: false }],
    ["a second tracked link", { trackedLinks: [{ destinationUrl: BODY.handoutUrl }, { destinationUrl: "https://evil.example" }] }],
  ])("answers 409 when the stored campaign has %s and shows it in the readback", async (_label, change) => {
    expect((await campaignsPOST(post(BODY))).status).toBe(201);
    Object.assign(stored[0], change);
    const conflict = await campaignsPOST(post(BODY));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ success: false, committed: false, error: "Reel already has a different campaign" });
    expect(m.create).toHaveBeenCalledTimes(1);
    const { trackedLinks, ...fields } = change as Record<string, unknown>;
    const readback = await (await campaignsGET(get(`/campaigns?mediaId=${BODY.mediaId}`))).json();
    expect(readback.data[0]).toMatchObject(trackedLinks ? { handoutUrls: [BODY.handoutUrl, "https://evil.example"] } : fields);
  });

  it("creates every execution field with its release value and exposes it in the readback", async () => {
    const created = await (await campaignsPOST(post(BODY))).json();
    const expected = {
      postId: BODY.mediaId, pendingNextReel: false, matchAnyPost: false, keywords: ["TV"], matchAnyWord: false, wholeWordMatch: true,
      dmTriggerEnabled: false, dmMessage: BODY.dmMessage, buttonLabel: BODY.buttonLabel, openingDmEnabled: false, openingDmMessage: null,
      openingDmButtonLabel: null, requireFollow: false, followPromptMessage: null, followPromptButtonLabel: null, followUpEnabled: false,
      followUpMessage: null, followUpDelayMinutes: 0, publicReplyEnabled: false, publicReplyMessage: null, publicReplyMessages: [],
      isActive: true, handoutUrls: [BODY.handoutUrl],
    };
    expect(created.data).toMatchObject(expected);
    expect((await (await campaignsGET(get(`/campaigns?mediaId=${BODY.mediaId}`))).json()).data[0]).toMatchObject(expected);
    expect(created.data).not.toHaveProperty("linkButtonLabel");
  });

  it("refuses when an any-post or next-reel campaign could answer the same comment", async () => {
    stored.push({ id: "manual", instagramAccountId: "kiby_conn", postId: null, matchAnyPost: true, isActive: true, trackedLinks: [] });
    expect((await campaignsPOST(post(BODY))).status).toBe(409);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("never sees campaigns of another account", async () => {
    stored.push({ id: "catno", instagramAccountId: "catno_conn", postId: BODY.mediaId, matchAnyPost: false, trackedLinks: [] });
    expect((await campaignsPOST(post(BODY))).status).toBe(201);
    expect((await (await campaignsGET(get(`/campaigns?mediaId=${BODY.mediaId}`))).json()).data).toHaveLength(1);
  });
});

describe("release campaign verification", () => {
  it.each([
    ["another reel", { permalink: "https://www.instagram.com/reel/OTHER/", caption: "#kibybyte12" }],
    ["a missing tag", { permalink: BODY.permalink, caption: "Kommentiere TV" }],
    ["a different tag", { permalink: BODY.permalink, caption: "#kibybyte13" }],
    ["two tags", { permalink: BODY.permalink, caption: "#kibybyte12 #kibybyte13" }],
  ])("rejects media with %s", async (_label, media) => {
    m.media.mockResolvedValueOnce({ id: BODY.mediaId, ...media });
    expect((await campaignsPOST(post(BODY))).status).toBe(409);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("rejects an unpublished handout and reports upstream errors without leaking them", async () => {
    m.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await campaignsPOST(post(BODY))).status).toBe(409);
    m.media.mockRejectedValueOnce(new Error("URL_WITH_SECRET_TOKEN"));
    const upstream = await campaignsPOST(post(BODY));
    expect(upstream.status).toBe(502);
    const body = await upstream.json();
    expect(body).toMatchObject({ committed: false });
    expect(JSON.stringify(body)).not.toContain("URL_WITH_SECRET_TOKEN");
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("marks an unexpected transaction failure as uncertain", async () => {
    m.transaction.mockRejectedValueOnce(new Error("connection lost during COMMIT"));
    const response = await campaignsPOST(post(BODY));
    expect(response.status).toBe(502);
    expect(await response.json()).not.toHaveProperty("committed");
  });

  it.each([
    ["an unknown field", { ...BODY, matchAnyPost: true }],
    ["a lower-case keyword", { ...BODY, keyword: "tv" }],
    ["a foreign handout host", { ...BODY, handoutUrl: "https://decks.catno.ai/drop/" }],
    ["a CATNO tag", { ...BODY, hashtag: "#catnodrop12" }],
    ["a long button", { ...BODY, buttonLabel: "x".repeat(21) }],
    ["a non-numeric media id", { ...BODY, mediaId: "abc" }],
  ])("validates %s", async (_label, body) => {
    expect((await campaignsPOST(post(body))).status).toBe(400);
    expect(m.media).not.toHaveBeenCalled();
  });

  it("validates the readback media id", async () => {
    expect((await campaignsGET(get("/campaigns?mediaId=abc"))).status).toBe(400);
  });
});

describe("DM text carries no link besides the validated handout", () => {
  it.each([
    "Hier: https://evil.example/phishing",
    "Hier: http://evil.example",
    "Hier: hxxp://evil.example",
    "Hier: hxxps evil",
    "Geh auf h t t p s evil",
    "Geh auf HTTP colon evil",
    "Hier: //evil.example",
    "Besuch www.evil.example",
    "Besuch w w w evil",
    "Besuch evil.example",
    "Besuch evil.de",
    "Besuch EVIL.COM",
    "Besuch evil . example",
    "Besuch evil\u034F.example",
    "Besuch evil\uFE0F.example",
    "Besuch evil.\u0301example",
    "Besuch evil .example",
    "Besuch evil. example",
    "Besuch evil. Com",
    "Besuch evil[.]example",
    "Besuch evil(.)example",
    "Besuch evil [dot] example",
    "Besuch evil dot com",
    "Besuch evil punkt de",
    "Besuch evil．example",
    "Besuch evil。example",
    "Besuch evil​.​example",
    "Besuch еvil.рф",
    "Besuch пример.испытание",
    "Besuch xn--e1afmkfd",
    "Schreib @evilhandle",
    "Mail an mailto:evil",
    "Ruf an tel:+49123",
    "javascript:alert(1)",
    // Any IANA TLD after a dot, whatever stands before it and however the dot is spaced or cased.
    "Besuch 💩.la",
    "Besuch evil. COMPUTER",
    "Besuch evil . COMPUTER",
    "Besuch example . de",
    "Besuch evil．COMPUTER",
    "Besuch 💩 ． la",
    "Besuch evil\u200B. \u200BCOMPUTER",
    "Besuch evil.\u200DLA",
    "Besuch evil. C O M",
    "Besuch evil. РФ",
    "Besuch evil Punkt COMPUTER",
    "Besuch ★. Shop",
    // IP addresses.
    "Geh auf 192.168.0.1",
    "Geh auf 192. 168. 0. 1",
    "Geh auf fe80::1",
    "Geh auf fe80::",
    "Besuch [2606:4700:4700::]",
    "Besuch 2606:4700:4700::",
    "Besuch ::",
  ])("rejects link-like DM text %j", async dmMessage => {
    const response = await campaignsPOST(post({ ...BODY, dmMessage }));
    expect(response.status).toBe(400);
    expect(m.media).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it.each(["evil.example", "www evil", "hxxp evil", "@evil", "💩.la", "Hi. COMPUTER", "x . de"])("rejects link-like button label %j", async buttonLabel => {
    expect((await campaignsPOST(post({ ...BODY, buttonLabel }))).status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("tells the caller that links and domains are not allowed in DM text", async () => {
    const response = await campaignsPOST(post({ ...BODY, dmMessage: "Besuch 💩.la" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/must not contain links, domains/);
  });

  it("rejects a sentence break before a TLD-like word on purpose", async () => {
    expect((await campaignsPOST(post({ ...BODY, dmMessage: "Super. Top Anleitung!" }))).status).toBe(400);
  });

  it.each([
    "Hier ist deine Schritt-für-Schritt-Anleitung aus dem Reel. Viel Spaß beim Ausprobieren!",
    "Danke fürs Kommentieren! Tipp: Speicher dir die Anleitung. Sie hilft beim Einrichten.",
    "Punkt für Punkt erklärt, ganz ohne Fachchinesisch.",
    "Schritt 1: Einstellungen öffnen. Schritt 2: Fernseher verbinden. Fertig!",
    "Kurz und knapp 💡 Viel Erfolg beim Nachmachen",
    "Um 12:30 Uhr geht's los. Bis gleich",
  ])("accepts plain prose %j", async dmMessage => {
    expect((await campaignsPOST(post({ ...BODY, dmMessage }))).status).toBe(201);
  });
});

describe("duplicate campaigns from other write paths are reported", () => {
  it("create reports duplicate when another active campaign appears on the reel", async () => {
    // A UI create that raced past the advisory lock lands after our insert.
    m.create.mockImplementationOnce(async (input: Parameters<typeof stub>[0]) => {
      const c = stub(input); stored.push(c);
      stored.push({ ...c, id: "ui-race", name: "UI" });
      return c;
    });
    const body = await (await campaignsPOST(post(BODY))).json();
    expect(body).toMatchObject({ success: true, created: true, duplicate: true });
  });

  it("create reports duplicate when an active any-post campaign appears meanwhile", async () => {
    // A UI any-post campaign committed after our pre-check; the worker would answer with both.
    m.create.mockImplementationOnce(async (input: Parameters<typeof stub>[0]) => {
      const c = stub(input); stored.push(c);
      stored.push({ id: "ui-any", instagramAccountId: "kiby_conn", postId: null, matchAnyPost: true, pendingNextReel: false, isActive: true, trackedLinks: [] });
      return c;
    });
    const body = await (await campaignsPOST(post(BODY))).json();
    expect(body).toMatchObject({ success: true, created: true, duplicate: true, data: { postId: BODY.mediaId } });
  });

  it("readback reports an active any-post or next-reel campaign as duplicate, not an inactive one", async () => {
    expect((await campaignsPOST(post(BODY))).status).toBe(201);
    const readback = async () => (await campaignsGET(get(`/campaigns?mediaId=${BODY.mediaId}`))).json();
    stored.push({ id: "any-off", instagramAccountId: "kiby_conn", postId: null, matchAnyPost: true, pendingNextReel: false, isActive: false, trackedLinks: [] });
    expect(await readback()).toMatchObject({ duplicate: false, data: [{ id: "camp1" }] });
    stored.push({ id: "next-on", instagramAccountId: "kiby_conn", postId: null, matchAnyPost: false, pendingNextReel: true, isActive: true, trackedLinks: [] });
    expect(await readback()).toMatchObject({ duplicate: true });
    stored.pop();
    stored.push({ id: "any-on", instagramAccountId: "kiby_conn", postId: null, matchAnyPost: true, pendingNextReel: false, isActive: true, trackedLinks: [] });
    const body = await readback();
    // `data` stays the reel's own campaigns; the any-post one only raises the flag.
    expect(body).toMatchObject({ duplicate: true, data: [{ id: "camp1" }] });
    expect(body.data).toHaveLength(1);
  });

  it("ignores any-post campaigns of another account", async () => {
    stored.push({ id: "catno-any", instagramAccountId: "catno_conn", postId: null, matchAnyPost: true, pendingNextReel: false, isActive: true, trackedLinks: [] });
    const body = await (await campaignsPOST(post(BODY))).json();
    expect(body).toMatchObject({ created: true, duplicate: false });
  });

  it("refuses a create while an active any-post campaign exists, but not an inactive one", async () => {
    stored.push({ id: "any-off", instagramAccountId: "kiby_conn", postId: null, matchAnyPost: true, pendingNextReel: false, isActive: false, trackedLinks: [] });
    expect((await campaignsPOST(post(BODY))).status).toBe(201);
    stored.length = 0;
    stored.push({ id: "any-on", instagramAccountId: "kiby_conn", postId: null, matchAnyPost: true, pendingNextReel: false, isActive: true, trackedLinks: [] });
    const refused = await campaignsPOST(post(BODY));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ committed: false, error: "Account has an any-post or next-reel campaign" });
  });

  it("readback reports duplicate for more than one active campaign, not for an inactive extra", async () => {
    expect((await campaignsPOST(post(BODY))).status).toBe(201);
    const single = await (await campaignsGET(get(`/campaigns?mediaId=${BODY.mediaId}`))).json();
    expect(single.duplicate).toBe(false);
    stored.push({ ...stored[0], id: "ui-off", isActive: false });
    expect((await (await campaignsGET(get(`/campaigns?mediaId=${BODY.mediaId}`))).json()).duplicate).toBe(false);
    stored.push({ ...stored[0], id: "ui-on", isActive: true });
    expect((await (await campaignsGET(get(`/campaigns?mediaId=${BODY.mediaId}`))).json()).duplicate).toBe(true);
  });
});
