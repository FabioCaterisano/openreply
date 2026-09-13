import { instagramShortcode } from "@/lib/drops/catalog";
import { resolveDrop } from "@/lib/drops/resolve";
import { releaseAccess, releaseFailure, ReleaseError } from "@/lib/internal/release-auth";

export async function GET(request: Request) {
  try {
    const { account } = await releaseAccess(request);
    const params = new URL(request.url).searchParams;
    const permalink = params.get("permalink");
    const dropNumber = Number(params.get("dropNumber"));
    if (!instagramShortcode(permalink) || !Number.isInteger(dropNumber) || dropNumber < 1 || dropNumber > 9999) throw new ReleaseError(400, "Invalid drop lookup");
    const data = await resolveDrop({ permalink, commentText: "", expectedDropNumber: dropNumber, forceRefresh: params.get("forceRefresh") === "true", strict: true });
    return Response.json({ success: true, accountId: account.instagramId, ready: data !== null, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return releaseFailure(error); }
}
