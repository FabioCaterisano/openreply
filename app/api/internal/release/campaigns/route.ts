import { releaseAccess, releaseFailure, ReleaseError } from "@/lib/internal/release-auth";
import { ensureReleaseCampaign, hasDuplicate, listReleaseCampaigns, validateCampaign, verifyHandout, verifyReleaseMedia } from "@/lib/internal/release-campaigns";

const NO_STORE = { "Cache-Control": "no-store" };

// `committed: false` is sent only when nothing can have been stored: any failure
// before the write transaction, or a refusal raised inside it before the insert.
// An unexpected error from the transaction itself (e.g. a lost COMMIT) carries no
// flag, like a proxy error or a timeout, so the client treats it as uncertain.
async function failure(error: unknown, committed: false | undefined): Promise<Response> {
  const response = releaseFailure(error);
  return Response.json({ ...(await response.json()), ...(committed === false ? { committed } : {}) }, { status: response.status, headers: NO_STORE });
}

/** Create (or return the identical existing) keyword campaign for one reel of the caller's own account. */
export async function POST(request: Request) {
  let writing = false;
  try {
    const { identity, account, context } = await releaseAccess(request, "campaigns");
    const text = await request.text();
    if (text.length > 16_384) throw new ReleaseError(413, "Campaign payload is too large");
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new ReleaseError(400, "Invalid JSON"); }
    const input = validateCampaign(body, identity, account.instagramId);
    await verifyReleaseMedia(context, identity, input);
    await verifyHandout(input.handoutUrl);
    writing = true;
    const { created, duplicate, campaign } = await ensureReleaseCampaign(account, identity, input);
    return Response.json({ success: true, committed: true, created, duplicate, accountId: account.instagramId, connectionId: account.id, data: campaign },
      { status: created ? 201 : 200, headers: NO_STORE });
  } catch (error) { return failure(error, !writing || error instanceof ReleaseError ? false : undefined); }
}

/** Readback: every campaign of the caller's own account bound to `mediaId`. */
export async function GET(request: Request) {
  try {
    const { account } = await releaseAccess(request, "campaigns");
    const data = await listReleaseCampaigns(account.id, new URL(request.url).searchParams.get("mediaId") ?? "");
    return Response.json({ success: true, accountId: account.instagramId, connectionId: account.id, duplicate: hasDuplicate(data), data },
      { headers: NO_STORE });
  } catch (error) { return releaseFailure(error); }
}
