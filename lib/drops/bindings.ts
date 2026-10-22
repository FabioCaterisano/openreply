import Redis from "ioredis";
import { instagramShortcode } from "@/lib/drops/catalog";
import { ReleaseError } from "@/lib/internal/release-auth";
import type { ResolvedDrop } from "@/lib/drops/resolve";

export type ReleaseBinding = {
  accountId: string;
  mediaId: string;
  permalink: string;
  dropNumber: number;
  slug: string;
  handoutUrl: string;
};

let redis: Redis | undefined;
function connection() {
  if (!process.env.REDIS_URL) throw new ReleaseError(503, "Binding store is unavailable");
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 5000, connectTimeout: 5000 });
    redis.on("error", () => {}); // The awaited command reports failure without leaking connection details.
  }
  return redis;
}

export function validateBinding(input: unknown, accountId: string): ReleaseBinding {
  const value = input as Partial<ReleaseBinding> | null;
  const code = instagramShortcode(value?.permalink ?? null);
  if (!value || value.accountId !== accountId || typeof value.mediaId !== "string" || !/^\d+$/.test(value.mediaId)
      || !code || !Number.isInteger(value.dropNumber) || value.dropNumber! < 1 || value.dropNumber! > 9999
      || typeof value.slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.slug)
      || value.handoutUrl !== `https://decks.catno.ai/${value.slug}/`) {
    throw new ReleaseError(400, "Invalid release binding");
  }
  return { accountId, mediaId: value.mediaId, permalink: `https://www.instagram.com/reel/${code}/`,
    dropNumber: value.dropNumber!, slug: value.slug, handoutUrl: value.handoutUrl };
}

// One atomic operation prevents concurrent aliases from binding a number or post to two handouts.
const WRITE_BINDING = `
for i = 1, 3 do
  local existing = redis.call('HGET', KEYS[1], ARGV[i])
  if existing and existing ~= ARGV[i + 3] then return 0 end
end
for i = 1, 3 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 3]) end
return 1`;

function key(accountId: string) { return `release:bindings:v1:${accountId}`; }

export async function saveReleaseBinding(binding: ReleaseBinding): Promise<void> {
  const data = JSON.stringify(binding);
  const stored = await connection().eval(WRITE_BINDING, 1, key(binding.accountId),
    `drop:${binding.dropNumber}`, `media:${binding.mediaId}`, `post:${instagramShortcode(binding.permalink)}`,
    JSON.stringify([binding.dropNumber, binding.slug, binding.handoutUrl]), data, data);
  if (stored !== 1) throw new ReleaseError(409, "Release binding conflicts with an existing identity");
}

export async function getReleaseBinding(permalink: string | null): Promise<ResolvedDrop | null> {
  const code = instagramShortcode(permalink);
  const accountId = process.env.CATNO_RELEASE_INSTAGRAM_ACCOUNT_ID;
  if (!code || !accountId || !process.env.REDIS_URL) return null;
  const raw = await connection().hget(key(accountId), `post:${code}`);
  if (!raw) return null;
  const value = validateBinding(JSON.parse(raw), accountId);
  if (instagramShortcode(value.permalink) !== code) throw new ReleaseError(409, "Release binding identity mismatch");
  return { dropNumber: value.dropNumber, slug: value.slug, handoutUrl: value.handoutUrl, matchedBy: "permalink" };
}
