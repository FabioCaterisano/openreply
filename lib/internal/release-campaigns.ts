import { prisma } from "@/lib/db/client";
import { instagramShortcode } from "@/lib/drops/catalog";
import { getMediaDetails, type InstagramContext } from "@/lib/instagram/provider";
import { IANA_TLDS } from "@/lib/internal/iana-tlds";
import { ReleaseError, type ReleaseIdentity } from "@/lib/internal/release-auth";
import { generateReportShareSlug } from "@/lib/reports/share";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";

/**
 * Per-reel keyword campaign for a release identity: a comment with `keyword` on
 * `mediaId` gets a DM with one tracked link to `handoutUrl`. The media id is the
 * idempotency key: the same request returns the same campaign, any difference
 * (or a foreign campaign on the reel) is a 409. Existing campaigns are never
 * modified or deleted here.
 */
export type ReleaseCampaignInput = {
  accountId: string;
  mediaId: string;
  permalink: string;
  hashtag: string;
  keyword: string;
  handoutUrl: string;
  dmMessage: string;
  buttonLabel: string;
};

const FIELDS = ["accountId", "mediaId", "permalink", "hashtag", "keyword", "handoutUrl", "dmMessage", "buttonLabel"] as const;
const KEYWORD = /^[A-Z0-9ÄÖÜ]{2,16}$/;

// The only outgoing link of a release campaign is the validated handout button, so DM text and
// button label must not carry anything a reader could follow or type as an address. Fail closed:
// plain prose passes, anything domain-, scheme-, IP- or handle-like (also defanged/obfuscated) is
// refused. False positives are accepted on purpose: a sentence break before a word that happens to
// be a TLD ("Super. Top", "Okay. Info") is rejected too, and the caller has to rephrase. Rejecting
// is the safe direction; a missed link would reach every commenter.
const DOT = "[.。｡．․‧∙⋅·•]";
const SEP = "[\\s._*\\-]*";
const LINK_LIKE: RegExp[] = [
  new RegExp(`[\\p{L}\\p{N}]${DOT}+[\\p{L}\\p{N}]`, "u"),                // evil.example, еvil.рф, 2.0
  new RegExp(`\\s${DOT}+\\s*[\\p{L}\\p{N}]`, "u"),                       // evil . example, evil .example
  new RegExp(`${DOT}\\s+\\p{Ll}`, "u"),                                  // evil. example (prose continues upper case)
  new RegExp(`[\\[({<]\\s*(?:${DOT}|dot|punkt)\\s*[\\])}>]`, "iu"),      // evil[.]example, evil (dot) example
  new RegExp(`\\p{L}\\s+dot\\s+\\p{L}`, "iu"),                           // evil dot example
  new RegExp(`(?:^|[^\\p{L}])h${SEP}[tx]${SEP}[tx]${SEP}p(?:${SEP}s)?(?![\\p{L}])`, "iu"), // http, hxxps, h t t p
  new RegExp(`(?:^|[^\\p{L}])w${SEP}w${SEP}w(?![\\p{L}])`, "iu"),        // www, w w w
  /(?:^|[^\p{L}])(?:ftp|mailto|tel|sms|javascript|data|file|intent|whatsapp|tg|itms[a-z-]*)\s*[:：]/iu,
  /[:：]\s*\/|\/\s*\//u,                                                 // ://, //
  /xn--/iu,                                                              // punycode IDN
  /[@＠]/u,                                                              // handles, mail addresses
  new RegExp(`\\d{1,3}(?:\\s*${DOT}\\s*\\d{1,3}){3}`, "u"),              // 1.2.3.4, 1. 2. 3. 4
  // Compressed IPv6 (any groups around `::`, also none: "::", "fe80::") or the full eight groups.
  /(?:^|[^\p{L}\p{N}:])[0-9a-f]{0,4}(?::[0-9a-f]{1,4})*::|(?:^|[^\p{L}\p{N}:])[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){7}(?![\p{L}\p{N}])/iu, // ::1, fe80::, 2606:4700::
];

function fold(text: string): string {
  // NFKC folds full-width and compatibility forms; invisible characters must not split a pattern.
  return text.normalize("NFKC").replace(/[\p{Default_Ignorable_Code_Point}\p{M}\p{Cf}]/gu, "");
}

// Every IANA TLD in the same folded, lower-cased form as the text it is compared with.
const TLDS: ReadonlySet<string> = new Set([...IANA_TLDS].map(tld => fold(tld).toLowerCase()));
// `<non-space> <dot> <label>`, spaces allowed around the dot, also spelled "dot"/"punkt". The label
// is the next word, or a run of single characters ("C O M") that a reader would join.
const DOT_LABEL = new RegExp(
  `(?<=\\S)\\s*(?:${DOT}+|(?<![\\p{L}\\p{N}])(?:dot|punkt)(?![\\p{L}\\p{N}]))\\s*([\\p{L}\\p{N}]+(?:\\s+[\\p{L}\\p{N}](?![\\p{L}\\p{N}]))*)`,
  "gu",
);

function tldAfterDot(folded: string): boolean {
  for (const [, label] of folded.toLowerCase().matchAll(DOT_LABEL)) {
    const words = label.split(/\s+/);
    if (TLDS.has(words[0]) || (words[0].length === 1 && TLDS.has(words.join("")))) return true;
  }
  return false;
}

export function linkLike(text: string): boolean {
  const folded = fold(text);
  return LINK_LIKE.some(pattern => pattern.test(folded)) || tldAfterDot(folded);
}

export function validateCampaign(input: unknown, identity: ReleaseIdentity, accountId: string): ReleaseCampaignInput {
  const policy = identity.campaign;
  if (!policy) throw new ReleaseError(403, "Forbidden for this release identity");
  const value = input as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReleaseError(400, "Invalid release campaign");
  if (Object.keys(value).some(key => !(FIELDS as readonly string[]).includes(key))) throw new ReleaseError(400, "Invalid release campaign");
  if (value.accountId !== accountId) throw new ReleaseError(403, "Account is not this release identity's account");
  const text = (key: string, max: number) => typeof value[key] === "string" && (value[key] as string).trim() === value[key]
    && (value[key] as string).length >= 1 && (value[key] as string).length <= max;
  const code = instagramShortcode(typeof value.permalink === "string" ? value.permalink : null);
  if (typeof value.mediaId !== "string" || !/^\d{1,32}$/.test(value.mediaId) || !code
      || typeof value.hashtag !== "string" || !policy.captionTag.test(value.hashtag)
      || typeof value.keyword !== "string" || !KEYWORD.test(value.keyword)
      || typeof value.handoutUrl !== "string" || !policy.handoutPattern.test(value.handoutUrl)
      || !text("dmMessage", 1000) || !text("buttonLabel", 20)) {
    throw new ReleaseError(400, "Invalid release campaign");
  }
  if (linkLike(value.dmMessage as string) || linkLike(value.buttonLabel as string)) {
    throw new ReleaseError(400, "dmMessage and buttonLabel must not contain links, domains, IP addresses or handles; "
      + "the handout button is the only link. A sentence break before a TLD-like word (e.g. \"Super. Top\") also counts, rephrase it");
  }
  return { accountId, mediaId: value.mediaId, permalink: `https://www.instagram.com/reel/${code}/`, hashtag: value.hashtag,
    keyword: value.keyword, handoutUrl: value.handoutUrl, dmMessage: value.dmMessage as string, buttonLabel: value.buttonLabel as string };
}

/** The reel must be this account's media with the expected permalink and exactly this release tag. */
export async function verifyReleaseMedia(context: InstagramContext, identity: ReleaseIdentity, input: ReleaseCampaignInput): Promise<void> {
  const media = await getMediaDetails({ context, mediaId: input.mediaId });
  const tags = [...(media.caption ?? "").matchAll(/#[\p{L}\p{N}_]+/gu)].map(m => m[0]).filter(tag => identity.campaign!.captionTag.test(tag));
  if (instagramShortcode(media.permalink) !== instagramShortcode(input.permalink) || tags.length !== 1 || tags[0] !== input.hashtag) {
    throw new ReleaseError(409, "Media does not match the release");
  }
}

export async function verifyHandout(url: string): Promise<void> {
  const page = await fetch(url, { method: "HEAD", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (page.status !== 200) throw new ReleaseError(409, "Handout is not publicly available");
}

/** Every campaign field the DM worker reads when it answers a comment or DM (lib/queue/dm-worker.ts). */
type ExecutionFields = {
  postId: string | null; pendingNextReel: boolean; matchAnyPost: boolean; keywords: string[]; matchAnyWord: boolean;
  wholeWordMatch: boolean; dmTriggerEnabled: boolean; dmMessage: string; linkButtonLabel: string | null;
  openingDmEnabled: boolean; openingDmMessage: string | null; openingDmButtonLabel: string | null;
  requireFollow: boolean; followPromptMessage: string | null; followPromptButtonLabel: string | null;
  followUpEnabled: boolean; followUpMessage: string | null; followUpDelayMinutes: number;
  publicReplyEnabled: boolean; publicReplyMessage: string | null; publicReplyMessages: string[]; isActive: boolean;
};

// Follow gate and public comment reply of a release campaign. These mirror the live CATNO campaigns,
// verified 2026-10-31 (reply.catno.ai GET /api/automations, all 4 campaigns of @catno.ai identical);
// copied verbatim, they name no channel. Changing them makes every existing release campaign a 409.
const FOLLOW_PROMPT_MESSAGE = "Fast 👀 Der Drop ist reserviert, aber ich sehe noch keinen Follow. Tipp oben auf meinen Namen, drück Folgen und komm zurück. Dann geht die Liste sofort raus. 💜";
const FOLLOW_PROMPT_BUTTON_LABEL = "Ich folge dir ✔\uFE0F";
const PUBLIC_REPLY_MESSAGE = "Check deine DMs 😃";
const PUBLIC_REPLY_MESSAGES = ["Check deine DMs 😃", "Ist raus ✅", "Hab's dir geschickt 📩"];

/**
 * The execution fields exactly as this endpoint creates them: a public comment reply, then the keyword
 * DM behind a follow gate (follow prompt → tap → follow check → handout button), no opening DM and no
 * follow-up. The create path writes this object and the idempotency check compares against it, so the
 * two cannot drift apart.
 */
function executionFields(input: ReleaseCampaignInput): ExecutionFields {
  return {
    postId: input.mediaId, pendingNextReel: false, matchAnyPost: false, keywords: [input.keyword], matchAnyWord: false,
    wholeWordMatch: true, dmTriggerEnabled: false, dmMessage: input.dmMessage, linkButtonLabel: input.buttonLabel,
    openingDmEnabled: false, openingDmMessage: null, openingDmButtonLabel: null,
    requireFollow: true, followPromptMessage: FOLLOW_PROMPT_MESSAGE, followPromptButtonLabel: FOLLOW_PROMPT_BUTTON_LABEL,
    followUpEnabled: false, followUpMessage: null, followUpDelayMinutes: 0,
    publicReplyEnabled: true, publicReplyMessage: PUBLIC_REPLY_MESSAGE, publicReplyMessages: [...PUBLIC_REPLY_MESSAGES], isActive: true,
  };
}

// `satisfies` fails the build when a field of ExecutionFields is not selected (or one is misspelt).
const EXECUTION_SELECT = {
  postId: true, pendingNextReel: true, matchAnyPost: true, keywords: true, matchAnyWord: true,
  wholeWordMatch: true, dmTriggerEnabled: true, dmMessage: true, linkButtonLabel: true,
  openingDmEnabled: true, openingDmMessage: true, openingDmButtonLabel: true,
  requireFollow: true, followPromptMessage: true, followPromptButtonLabel: true,
  followUpEnabled: true, followUpMessage: true, followUpDelayMinutes: true,
  publicReplyEnabled: true, publicReplyMessage: true, publicReplyMessages: true, isActive: true,
} as const satisfies Record<keyof ExecutionFields, true>;
const EXECUTION_KEYS = Object.keys(EXECUTION_SELECT) as (keyof ExecutionFields)[];

type StoredCampaign = ExecutionFields & {
  id: string; name: string; postUrl: string | null; createdAt: Date; trackedLinks: { destinationUrl: string }[];
};

const SELECT = {
  id: true, name: true, postUrl: true, createdAt: true, ...EXECUTION_SELECT,
  trackedLinks: { select: { destinationUrl: true }, orderBy: { createdAt: "asc" as const } },
};

/** Shows every execution field, so a readback exposes any deviation from what this endpoint creates. */
export function campaignView(campaign: StoredCampaign) {
  const { linkButtonLabel, ...execution } = Object.fromEntries(EXECUTION_KEYS.map(key => [key, campaign[key]])) as ExecutionFields;
  return {
    id: campaign.id, name: campaign.name, postUrl: campaign.postUrl, ...execution, buttonLabel: linkButtonLabel,
    handoutUrls: campaign.trackedLinks.map(link => link.destinationUrl), createdAt: campaign.createdAt.toISOString(),
  };
}

/** Fail closed: any execution field that differs from a fresh create (e.g. an added opening DM) is a different campaign. */
function sameCampaign(campaign: StoredCampaign, input: ReleaseCampaignInput): boolean {
  const expected = executionFields(input);
  return instagramShortcode(campaign.postUrl) === instagramShortcode(input.permalink)
    && EXECUTION_KEYS.every(key => JSON.stringify(campaign[key] ?? null) === JSON.stringify(expected[key]))
    && campaign.trackedLinks.length === 1 && campaign.trackedLinks[0].destinationUrl === input.handoutUrl;
}

/**
 * Every campaign that can answer a comment on the reel: those bound to it, plus the account's active
 * any-post campaigns (the worker matches them on every post) and next-reel campaigns (they bind to
 * whatever reel is published next).
 */
function competingWhere(instagramAccountId: string, mediaId: string) {
  return { instagramAccountId, OR: [{ postId: mediaId }, { isActive: true, matchAnyPost: true }, { isActive: true, pendingNextReel: true }] };
}

/**
 * Readback: `campaigns` are the ones bound to the reel; `duplicate` also counts the account's active
 * any-post and next-reel campaigns, since each of them would DM the same commenter a second time.
 */
export async function listReleaseCampaigns(instagramAccountId: string, mediaId: string) {
  if (!/^\d{1,32}$/.test(mediaId)) throw new ReleaseError(400, "Invalid media id");
  const competing = await prisma.automation.findMany({ where: competingWhere(instagramAccountId, mediaId), select: SELECT, orderBy: { createdAt: "asc" } });
  return { campaigns: competing.filter(campaign => campaign.postId === mediaId).map(campaignView), duplicate: hasDuplicate(competing) };
}

/**
 * More than one active campaign answers the reel. The advisory lock only serialises this endpoint;
 * the session UI (create, import) writes without it and there is no unique constraint, so a racing UI
 * write (bound to the reel or any-post) is detected here instead of prevented. The client blocks on it.
 */
export function hasDuplicate(campaigns: { isActive: boolean }[]): boolean {
  return campaigns.filter(campaign => campaign.isActive).length > 1;
}

export async function ensureReleaseCampaign(
  account: { id: string; workspaceId: string },
  identity: ReleaseIdentity,
  input: ReleaseCampaignInput,
): Promise<{ created: boolean; duplicate: boolean; campaign: ReturnType<typeof campaignView> }> {
  const result = await writeReleaseCampaign(account, identity, input);
  // Read after commit so writes that committed meanwhile from other paths are visible.
  return { ...result, duplicate: (await listReleaseCampaigns(account.id, input.mediaId)).duplicate };
}

async function writeReleaseCampaign(
  account: { id: string; workspaceId: string },
  identity: ReleaseIdentity,
  input: ReleaseCampaignInput,
): Promise<{ created: boolean; campaign: ReturnType<typeof campaignView> }> {
  return prisma.$transaction(async tx => {
    // Serialises concurrent creates for one reel; released with the transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`release-campaign:${account.id}:${input.mediaId}`}::text))`;
    const competing = await tx.automation.findMany({ where: competingWhere(account.id, input.mediaId), select: SELECT, orderBy: { createdAt: "asc" } });
    // An active any-post or next-reel campaign would answer the same comments a second time.
    if (competing.some(c => c.isActive && (c.matchAnyPost || c.pendingNextReel || c.postId !== input.mediaId))) {
      throw new ReleaseError(409, "Account has an any-post or next-reel campaign");
    }
    if (competing.length === 1 && sameCampaign(competing[0], input)) return { created: false, campaign: campaignView(competing[0]) };
    if (competing.length > 0) throw new ReleaseError(409, "Reel already has a different campaign");
    const campaign = await tx.automation.create({
      data: {
        workspaceId: account.workspaceId, instagramAccountId: account.id,
        name: `${identity.campaign!.label} ${input.hashtag} · ${input.keyword}`, goal: "Lead magnet delivery",
        postUrl: input.permalink, ...executionFields(input), reportShareSlug: generateReportShareSlug(),
        trackedLinks: { create: [{ workspaceId: account.workspaceId, slug: generateTrackedLinkSlug(), label: "Primary campaign link", destinationUrl: input.handoutUrl }] },
      },
      select: SELECT,
    });
    return { created: true, campaign: campaignView(campaign) };
  });
}
