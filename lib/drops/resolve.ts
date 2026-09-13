import { instagramShortcode, loadDrops, parseDropNumber, type Drop } from "@/lib/drops/catalog";

export type ResolvedDrop = {
  dropNumber: number;
  slug: string;
  handoutUrl: string;
  matchedBy: "permalink" | "number";
};

type ResolveInput = {
  permalink: string | null;
  commentText: string;
  expectedDropNumber?: number;
  forceRefresh?: boolean;
  strict?: boolean;
};

function eligible(drop: Drop): boolean {
  if (!drop || drop.status !== "public" || !Number.isInteger(drop.drop_number)) return false;
  try { return new URL(drop.handout_url).protocol === "https:"; } catch { return false; }
}

function result(hits: Drop[], matchedBy: ResolvedDrop["matchedBy"]): ResolvedDrop | null {
  // Conflicting aliases are never resolved by catalog ordering.
  const identities = new Set(hits.map(d => JSON.stringify([d.drop_number, d.slug, d.handout_url])));
  if (identities.size !== 1 || !hits.every(eligible)) return null;
  const hit = hits[0];
  return { dropNumber: hit.drop_number, slug: hit.slug, handoutUrl: hit.handout_url, matchedBy };
}

function match(drops: Drop[], input: ResolveInput): ResolvedDrop | null {
  const code = instagramShortcode(input.permalink);
  if (code) {
    const hits = drops.filter(d => d && [d.instagram_url, ...(Array.isArray(d.instagram_urls) ? d.instagram_urls : [])]
      .some(url => instagramShortcode(url) === code));
    if (hits.length) {
      const resolved = result(hits, "permalink");
      return resolved && (input.expectedDropNumber == null || resolved.dropNumber === input.expectedDropNumber) ? resolved : null;
    }
  }
  // Tagged reels require an explicit alias, not the number from a comment or sister post.
  if (input.expectedDropNumber != null) return null;
  const number = parseDropNumber(input.commentText);
  return number == null ? null : result(drops.filter(d => d?.drop_number === number), "number");
}

export async function resolveDrop(input: ResolveInput): Promise<ResolvedDrop | null> {
  const first = await loadDrops({ forceRefresh: input.forceRefresh, strict: input.strict });
  const hit = match(first, input);
  if (hit || input.forceRefresh) return hit;
  return match(await loadDrops({ forceRefresh: true, strict: input.strict }), input);
}

export function taggedDropNumber(caption: string): { tagged: boolean; number: number | null } {
  const numbers = [...caption.matchAll(/(?:^|[^\p{L}\p{N}_])#catnodrop([1-9]\d{0,3})(?![\p{L}\p{N}_])/gu)].map(m => Number(m[1]));
  const unique = new Set(numbers);
  return { tagged: numbers.length > 0, number: unique.size === 1 ? numbers[0] : null };
}
