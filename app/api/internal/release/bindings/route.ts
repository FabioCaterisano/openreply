import { prisma } from "@/lib/db/client";
import { saveReleaseBinding, validateBinding } from "@/lib/drops/bindings";
import { releaseAccess, releaseFailure, ReleaseError } from "@/lib/internal/release-auth";

// The authenticated sole writer supplies identities from its complete own-account scan.
// It verifies public registry classification independently of catalog/cover publication.
export async function POST(request: Request) {
  try {
    const { account } = await releaseAccess(request, "bindings");
    const text = await request.text();
    if (text.length > 16_384) throw new ReleaseError(413, "Binding payload is too large");
    let input: unknown;
    try { input = JSON.parse(text); } catch { throw new ReleaseError(400, "Invalid JSON"); }
    const binding = validateBinding(input, account.instagramId);
    const page = await fetch(binding.handoutUrl, { method: "HEAD", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (page.status !== 200) throw new ReleaseError(409, "Handout is not publicly available");
    await saveReleaseBinding(binding);
    // Only wake undelivered comments; execution claims and uncertain-delivery guards remain intact.
    const now = new Date();
    await prisma.dmLog.updateMany({ where: {
      instagramAccountId: account.id, mediaId: binding.mediaId, dropPending: true,
      status: { in: ["PENDING", "FAILED"] }, dmDeliveryUnconfirmed: false,
      OR: [{ dropClaimUntil: null }, { dropClaimUntil: { lte: now } }],
    }, data: { dropRetryAt: now } });
    return Response.json({ success: true, accountId: account.instagramId, data: binding }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return releaseFailure(error); }
}
