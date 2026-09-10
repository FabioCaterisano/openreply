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
  status: string;
};

type Catalog = { drops: Drop[] };

let cache: { drops: Drop[]; fetchedAt: number } | null = null;

export function __resetDropsCache(): void {
  cache = null;
}

function cacheSeconds(): number {
  const raw = Number(process.env.DROPS_CACHE_SECONDS ?? "300");
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

export async function loadDrops(): Promise<Drop[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < cacheSeconds() * 1000) return cache.drops;
  const url = process.env.DROPS_JSON_URL ?? "https://decks.catno.ai/freestuff/drops.json";
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`drops.json ${response.status}`);
    const data = (await response.json()) as Catalog;
    const drops = Array.isArray(data.drops) ? data.drops : [];
    cache = { drops, fetchedAt: now };
    return drops;
  } catch (error) {
    console.log("[drops] catalog fetch failed:", error instanceof Error ? error.message : error);
    return cache?.drops ?? [];
  }
}

// Optional profile segment: share links look like /<username>/reel/<code>/.
const SHORTCODE_RE = /instagram\.com\/(?:[^/?#]+\/)?(?:reel|reels|p)\/([A-Za-z0-9_-]+)/;

/** Shortcode of a reel/post URL, or null when it is not a media URL. */
export function instagramShortcode(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = SHORTCODE_RE.exec(url);
  return match ? match[1] : null;
}

const DROP_NUMBER_RE = /\bdrop\s*#?\s*(\d{1,4})\b/i;

/** Number after DROP in a comment ("DROP 27", "drop#27", "Drop27"). */
export function parseDropNumber(commentText: string): number | null {
  const match = DROP_NUMBER_RE.exec(commentText ?? "");
  return match ? Number(match[1]) : null;
}
