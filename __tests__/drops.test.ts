import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  instagramShortcode,
  parseDropNumber,
  __resetDropsCache,
} from "@/lib/drops/catalog";
import { resolveDrop, taggedDropNumber } from "@/lib/drops/resolve";

const CATALOG = {
  premium_enabled: false,
  categories: [],
  drops: [
    {
      drop_number: 27,
      slug: "gpt-weiss-alles",
      title: "Was ChatGPT über dich weiß",
      handout_url: "https://decks.catno.ai/gpt-weiss-alles/",
      instagram_url: "https://www.instagram.com/reel/DQx1AbC2dEf/?igsh=abc",
      status: "public",
    },
    {
      drop_number: 12,
      slug: "freeze",
      title: "12 Freeze Prompts",
      handout_url: "https://decks.catno.ai/freeze/",
      instagram_url: null,
      status: "public",
    },
    {
      drop_number: 99,
      slug: "draft",
      title: "Entwurf",
      handout_url: "https://decks.catno.ai/draft/",
      instagram_url: null,
      status: "draft",
    },
    {
      drop_number: 42,
      slug: "insecure",
      title: "Kein https",
      handout_url: "http://decks.catno.ai/insecure/",
      instagram_url: "https://www.instagram.com/reel/HTTPonly1234/",
      status: "public",
    },
  ],
};

describe("instagramShortcode", () => {
  it("extracts reel and post shortcodes and ignores query/hash", () => {
    expect(instagramShortcode("https://www.instagram.com/reel/DQx1AbC2dEf/?igsh=abc")).toBe("DQx1AbC2dEf");
    expect(instagramShortcode("https://instagram.com/p/DQx1AbC2dEf")).toBe("DQx1AbC2dEf");
    expect(instagramShortcode("https://www.instagram.com/reels/DQx1AbC2dEf/#x")).toBe("DQx1AbC2dEf");
    expect(instagramShortcode("https://www.instagram.com/catno.ai/reel/DQx1AbC2dEf/")).toBe("DQx1AbC2dEf");
    expect(instagramShortcode("https://www.instagram.com/catno.ai/")).toBeNull();
    expect(instagramShortcode(null)).toBeNull();
  });
});

describe("parseDropNumber", () => {
  it("reads the number after DROP in any casing and spacing", () => {
    expect(parseDropNumber("DROP 27")).toBe(27);
    expect(parseDropNumber("drop#27 bitte")).toBe(27);
    expect(parseDropNumber("Drop27")).toBe(27);
    expect(parseDropNumber("DROP")).toBeNull();
    expect(parseDropNumber("ich will 27")).toBeNull();
  });
});

describe("resolveDrop", () => {
  beforeEach(() => {
    __resetDropsCache();
    process.env.DROPS_JSON_URL = "https://decks.catno.ai/freestuff/drops.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => CATALOG }))
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("matches by permalink first", async () => {
    const r = await resolveDrop({
      permalink: "https://www.instagram.com/reel/DQx1AbC2dEf/",
      commentText: "DROP 12",
    });
    expect(r).toEqual({
      dropNumber: 27,
      slug: "gpt-weiss-alles",
      handoutUrl: "https://decks.catno.ai/gpt-weiss-alles/",
      matchedBy: "permalink",
    });
  });

  it("falls back to the number in the comment", async () => {
    const r = await resolveDrop({ permalink: null, commentText: "drop 12" });
    expect(r?.slug).toBe("freeze");
    expect(r?.matchedBy).toBe("number");
  });

  it("ignores non-public drops and returns null when nothing matches", async () => {
    expect(await resolveDrop({ permalink: null, commentText: "DROP 99" })).toBeNull();
    expect(await resolveDrop({ permalink: null, commentText: "DROP" })).toBeNull();
  });

  it("ignores drops whose handout_url is not https", async () => {
    expect(
      await resolveDrop({
        permalink: "https://www.instagram.com/reel/HTTPonly1234/",
        commentText: "DROP",
      })
    ).toBeNull();
    expect(await resolveDrop({ permalink: null, commentText: "DROP 42" })).toBeNull();
  });

  it("caches the catalog between calls", async () => {
    await resolveDrop({ permalink: null, commentText: "DROP 12" });
    await resolveDrop({ permalink: null, commentText: "DROP 27" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("survives a catalog fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(await resolveDrop({ permalink: null, commentText: "DROP 12" })).toBeNull();
  });

  it("matches every repost alias and rejects conflicts across drops", async () => {
    const alias = "https://instagram.com/reel/REPOST27/";
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ drops: [{ ...CATALOG.drops[0], instagram_url: null, instagram_urls: [alias] }] }) } as Response);
    expect((await resolveDrop({ permalink: alias, commentText: "", expectedDropNumber: 27 }))?.dropNumber).toBe(27);
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ drops: [{ ...CATALOG.drops[0], instagram_urls: [alias] }, { ...CATALOG.drops[1], instagram_urls: [alias] }] }) } as Response);
    expect(await resolveDrop({ permalink: alias, commentText: "DROP 27", forceRefresh: true })).toBeNull();
  });

  it("refreshes a cache miss immediately and coalesces concurrent refreshes", async () => {
    await resolveDrop({ permalink: null, commentText: "DROP 12" });
    const alias = "https://instagram.com/reel/NEW27/";
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ drops: [{ ...CATALOG.drops[0], instagram_urls: [alias] }] }) } as Response);
    const hits = await Promise.all([1, 2, 3].map(() => resolveDrop({ permalink: alias, commentText: "", expectedDropNumber: 27 })));
    expect(hits.every(hit => hit?.dropNumber === 27)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ cache: "no-store" }));
  });

  it("requires the permalink and expected number together", async () => {
    expect(await resolveDrop({ permalink: "https://instagram.com/reel/UNBOUND/", commentText: "DROP 27", expectedDropNumber: 27 })).toBeNull();
    expect(await resolveDrop({ permalink: CATALOG.drops[0].instagram_url, commentText: "DROP 12", expectedDropNumber: 12 })).toBeNull();
  });

  it("strict readback does not report stale readiness after a failed refresh", async () => {
    await resolveDrop({ permalink: null, commentText: "DROP 12" });
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    await expect(resolveDrop({ permalink: null, commentText: "DROP 12", forceRefresh: true, strict: true })).rejects.toThrow("offline");
    expect((await resolveDrop({ permalink: null, commentText: "DROP 12" }))?.dropNumber).toBe(12);
  });
});

it("parses only complete own machine tags", () => {
  expect(taggedDropNumber("#catnodrop27 https://instagram.com/reel/SISTER/")).toEqual({ tagged: true, number: 27 });
  expect(taggedDropNumber("#catnodrop27 #catnodrop31")).toEqual({ tagged: true, number: null });
  expect(taggedDropNumber("#catnodrop27suffix #CATNODROP27")).toEqual({ tagged: false, number: null });
  expect(instagramShortcode("https://evilinstagram.com/reel/EVIL/")).toBeNull();
});
