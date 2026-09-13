/**
 * CATNO drops catalog: the same drops.json that feeds catno.ai/free.
 * Fetched lazily, cached in-process, never throws (returns last good copy or []).
 */
export type Drop = {
  drop_number: number;
  slug: string;
  title: string;
  handout_url: string;
  instagram_url: string | null;
  instagram_urls?: string[];
  status: string;
};

type Catalog = { drops: Drop[] };

let cache: { drops: Drop[]; fetchedAt: number } | null = null;
let refreshing: Promise<Drop[]> | null = null;

export function __resetDropsCache(): void {
  cache = null;
  refreshing = null;
}

function cacheSeconds(): number {
  const raw = Number(process.env.DROPS_CACHE_SECONDS ?? "300");
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

export async function loadDrops(options: { forceRefresh?: boolean; strict?: boolean } = {}): Promise<Drop[]> {
  const now = Date.now();
  if (!options.forceRefresh && cache && now - cache.fetchedAt < cacheSeconds() * 1000) return cache.drops;
  if (!refreshing) refreshing = fetchDrops().finally(() => { refreshing = null; });
  try { return await refreshing; } catch (error) {
    if (options.strict) throw error;
    return cache?.drops ?? [];
  }
}

async function fetchDrops(): Promise<Drop[]> {
  const url = process.env.DROPS_JSON_URL ?? "https://decks.catno.ai/freestuff/drops.json";
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`drops.json ${response.status}`);
    const data = (await response.json()) as Catalog;
    if (!Array.isArray(data.drops)) throw new Error("Invalid drops catalog");
    const drops = data.drops;
    cache = { drops, fetchedAt: Date.now() };
    return drops;
  } catch (error) {
    console.log("[drops] catalog fetch failed:", error instanceof Error ? error.message : error);
    throw error;
  }
}

// Optional profile segment: share links look like /<username>/reel/<code>/.
const SHORTCODE_RE = /instagram\.com\/(?:[^/?#]+\/)?(?:reel|reels|p)\/([A-Za-z0-9_-]+)/;

/** Shortcode of a reel/post URL, or null when it is not a media URL. */
export function instagramShortcode(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (!["instagram.com", "www.instagram.com"].includes(parsed.hostname) || parsed.protocol !== "https:") return null;
  } catch { return null; }
  const match = SHORTCODE_RE.exec(url);
  return match ? match[1] : null;
}

const DROP_NUMBER_RE = /\bdrop\s*#?\s*(\d{1,4})\b/i;

/** Number after DROP in a comment ("DROP 27", "drop#27", "Drop27"). */
export function parseDropNumber(commentText: string): number | null {
  const match = DROP_NUMBER_RE.exec(commentText ?? "");
  return match ? Number(match[1]) : null;
}
