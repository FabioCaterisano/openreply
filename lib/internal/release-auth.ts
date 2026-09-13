import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { createInstagramContext } from "@/lib/instagram/provider";

export class ReleaseError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function releaseAccess(request: Request) {
  const secret = process.env.CATNO_RELEASE_SECRET;
  const supplied = request.headers.get("authorization") ?? "";
  if (!secret || supplied.length !== `Bearer ${secret}`.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(`Bearer ${secret}`))) {
    throw new ReleaseError(401, "Unauthorized");
  }
  const instagramId = process.env.CATNO_RELEASE_INSTAGRAM_ACCOUNT_ID;
  if (!instagramId) throw new ReleaseError(503, "Release account is not configured");
  const account = await prisma.instagramAccount.findUnique({ where: { instagramId } });
  if (!account) throw new ReleaseError(503, "Release account is unavailable");
  if (account.provider !== "META") throw new ReleaseError(409, "Unsupported provider: META is required");
  return { account, context: await createInstagramContext(account) };
}

function signature(body: string): string {
  return createHmac("sha256", process.env.CATNO_RELEASE_SECRET!).update(body).digest("base64url");
}

export function encodeMediaCursor(accountId: string, after: string): string {
  const body = Buffer.from(JSON.stringify({ accountId, after })).toString("base64url");
  return `${body}.${signature(body)}`;
}

export function decodeMediaCursor(cursor: string | null, accountId: string): string | undefined {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 4096) throw new Error();
    const parts = cursor.split(".");
    if (parts.length !== 2) throw new Error();
    const expected = Buffer.from(signature(parts[0]));
    const supplied = Buffer.from(parts[1]);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const data = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    if (data.accountId !== accountId || typeof data.after !== "string" || !data.after) throw new Error();
    return data.after as string;
  } catch { throw new ReleaseError(400, "Invalid cursor"); }
}

export function releaseFailure(error: unknown): Response {
  const status = error instanceof ReleaseError ? error.status : 502;
  return Response.json({ success: false, error: error instanceof ReleaseError ? error.message : "Release data is temporarily unavailable" }, { status, headers: { "Cache-Control": "no-store" } });
}
