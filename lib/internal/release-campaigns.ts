import { prisma } from "@/lib/db/client";
import { instagramShortcode } from "@/lib/drops/catalog";
import { getMediaDetails, type InstagramContext } from "@/lib/instagram/provider";
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

type StoredCampaign = {
  id: string; name: string; postId: string | null; postUrl: string | null; keywords: string[]; matchAnyWord: boolean;
  matchAnyPost: boolean; pendingNextReel: boolean; dmTriggerEnabled: boolean; dmMessage: string; linkButtonLabel: string | null;
  isActive: boolean; createdAt: Date; trackedLinks: { destinationUrl: string }[];
};

const SELECT = {
  id: true, name: true, postId: true, postUrl: true, keywords: true, matchAnyWord: true, matchAnyPost: true,
  pendingNextReel: true, dmTriggerEnabled: true, dmMessage: true, linkButtonLabel: true, isActive: true, createdAt: true,
  trackedLinks: { select: { destinationUrl: true }, orderBy: { createdAt: "asc" as const } },
};

export function campaignView(campaign: StoredCampaign) {
  return {
    id: campaign.id, name: campaign.name, postId: campaign.postId, postUrl: campaign.postUrl, keywords: campaign.keywords,
    matchAnyWord: campaign.matchAnyWord, matchAnyPost: campaign.matchAnyPost, pendingNextReel: campaign.pendingNextReel,
    dmTriggerEnabled: campaign.dmTriggerEnabled, dmMessage: campaign.dmMessage, buttonLabel: campaign.linkButtonLabel,
    isActive: campaign.isActive, handoutUrls: campaign.trackedLinks.map(link => link.destinationUrl),
    createdAt: campaign.createdAt.toISOString(),
  };
}

function sameCampaign(campaign: StoredCampaign, input: ReleaseCampaignInput): boolean {
  return campaign.postId === input.mediaId && instagramShortcode(campaign.postUrl) === instagramShortcode(input.permalink)
    && campaign.keywords.length === 1 && campaign.keywords[0] === input.keyword && !campaign.matchAnyWord
    && !campaign.matchAnyPost && !campaign.pendingNextReel && !campaign.dmTriggerEnabled
    && campaign.dmMessage === input.dmMessage && campaign.linkButtonLabel === input.buttonLabel
    && campaign.trackedLinks.length === 1 && campaign.trackedLinks[0].destinationUrl === input.handoutUrl;
}

export async function listReleaseCampaigns(instagramAccountId: string, mediaId: string) {
  if (!/^\d{1,32}$/.test(mediaId)) throw new ReleaseError(400, "Invalid media id");
  const campaigns = await prisma.automation.findMany({ where: { instagramAccountId, postId: mediaId }, select: SELECT, orderBy: { createdAt: "asc" } });
  return campaigns.map(campaignView);
}

export async function ensureReleaseCampaign(
  account: { id: string; workspaceId: string },
  identity: ReleaseIdentity,
  input: ReleaseCampaignInput,
): Promise<{ created: boolean; campaign: ReturnType<typeof campaignView> }> {
  return prisma.$transaction(async tx => {
    // Serialises concurrent creates for one reel; released with the transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`release-campaign:${account.id}:${input.mediaId}`}::text))`;
    const competing = await tx.automation.findMany({
      where: { instagramAccountId: account.id, OR: [{ postId: input.mediaId }, { isActive: true, matchAnyPost: true }, { isActive: true, pendingNextReel: true }] },
      select: SELECT, orderBy: { createdAt: "asc" },
    });
    // An any-post or next-reel campaign would answer the same comments a second time.
    if (competing.some(c => c.postId !== input.mediaId)) throw new ReleaseError(409, "Account has an any-post or next-reel campaign");
    if (competing.length === 1 && sameCampaign(competing[0], input)) return { created: false, campaign: campaignView(competing[0]) };
    if (competing.length > 0) throw new ReleaseError(409, "Reel already has a different campaign");
    const campaign = await tx.automation.create({
      data: {
        workspaceId: account.workspaceId, instagramAccountId: account.id,
        name: `${identity.campaign!.label} ${input.hashtag} · ${input.keyword}`, goal: "Lead magnet delivery",
        postId: input.mediaId, postUrl: input.permalink, pendingNextReel: false, matchAnyPost: false,
        keywords: [input.keyword], matchAnyWord: false, dmTriggerEnabled: false, wholeWordMatch: true,
        dmMessage: input.dmMessage, linkButtonLabel: input.buttonLabel, isActive: true,
        reportShareSlug: generateReportShareSlug(),
        trackedLinks: { create: [{ workspaceId: account.workspaceId, slug: generateTrackedLinkSlug(), label: "Primary campaign link", destinationUrl: input.handoutUrl }] },
      },
      select: SELECT,
    });
    return { created: true, campaign: campaignView(campaign) };
  });
}
