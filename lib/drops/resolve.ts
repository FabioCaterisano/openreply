import { instagramShortcode, loadDrops, parseDropNumber } from "@/lib/drops/catalog";

export type ResolvedDrop = {
  dropNumber: number;
  slug: string;
  handoutUrl: string;
  matchedBy: "permalink" | "number";
};

/**
 * Which handout belongs to this comment? Permalink match wins (exact reel),
 * then the number after DROP in the comment text. Only public drops count.
 */
export async function resolveDrop(input: {
  permalink: string | null;
  commentText: string;
}): Promise<ResolvedDrop | null> {
  const drops = (await loadDrops()).filter((d) => d.status === "public");
  if (drops.length === 0) return null;

  const code = instagramShortcode(input.permalink);
  if (code) {
    const hit = drops.find((d) => instagramShortcode(d.instagram_url) === code);
    if (hit) {
      return { dropNumber: hit.drop_number, slug: hit.slug, handoutUrl: hit.handout_url, matchedBy: "permalink" };
    }
  }

  const number = parseDropNumber(input.commentText);
  if (number != null) {
    const hit = drops.find((d) => d.drop_number === number);
    if (hit) {
      return { dropNumber: hit.drop_number, slug: hit.slug, handoutUrl: hit.handout_url, matchedBy: "number" };
    }
  }

  return null;
}
