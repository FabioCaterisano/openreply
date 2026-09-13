import { getUserMediaPage } from "@/lib/instagram/provider";
import { decodeMediaCursor, encodeMediaCursor, releaseAccess, releaseFailure, ReleaseError } from "@/lib/internal/release-auth";

export async function GET(request: Request) {
  try {
    const { account, context } = await releaseAccess(request);
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get("limit") ?? "100");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ReleaseError(400, "Invalid limit");
    const after = decodeMediaCursor(params.get("cursor"), account.instagramId);
    const page = await getUserMediaPage({ context, after, limit });
    return Response.json({ success: true, accountId: account.instagramId, connectionId: account.id, provider: "META",
      data: page.data.map(({ id, caption, permalink, timestamp, thumbnail_url, media_type, media_product_type }) => ({ id, caption: caption ?? "", permalink, timestamp, thumbnail_url, media_type, media_product_type })),
      pagination: { hasMore: page.after !== null, cursor: page.after ? encodeMediaCursor(account.instagramId, page.after) : null },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return releaseFailure(error); }
}
