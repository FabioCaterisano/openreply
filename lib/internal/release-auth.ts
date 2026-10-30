import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { createInstagramContext } from "@/lib/instagram/provider";

export class ReleaseError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type ReleaseScope = "media" | "resolve" | "bindings" | "campaigns";

export type ReleaseIdentity = {
  name: "catno" | "kibybyte";
  /** Env holding this caller's Bearer secret. */
  secretEnv: string;
  /** Env holding the native Instagram ID of the one account this caller may act on. */
  accountEnv: string;
  scopes: readonly ReleaseScope[];
  /** Per-reel keyword campaigns; only identities with the "campaigns" scope carry a policy. */
  campaign?: { label: string; handoutPattern: RegExp; captionTag: RegExp };
};

// Explicit allowlist: the bearer selects exactly one identity, and an identity is
// bound to exactly one account. Adding a caller means adding a row here, never a
// request parameter. CATNO keeps its original scopes and env names unchanged.
export const RELEASE_IDENTITIES: readonly ReleaseIdentity[] = [
  { name: "catno", secretEnv: "CATNO_RELEASE_SECRET", accountEnv: "CATNO_RELEASE_INSTAGRAM_ACCOUNT_ID", scopes: ["media", "resolve", "bindings"] },
  { name: "kibybyte", secretEnv: "KIBYBYTE_RELEASE_SECRET", accountEnv: "KIBYBYTE_RELEASE_INSTAGRAM_ACCOUNT_ID", scopes: ["campaigns"],
    campaign: { label: "KIbyByte", handoutPattern: /^https:\/\/handouts\.kibybyte\.de\/[0-9]{3,4}-[a-z0-9][a-z0-9-]{0,80}\/$/, captionTag: /^#kibybyte[1-9][0-9]{0,3}$/ } },
];

function matches(supplied: string, secret: string | undefined): boolean {
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(supplied);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Identity whose secret equals the bearer; every configured secret is compared. */
export function releaseIdentity(request: Request): ReleaseIdentity {
  const supplied = request.headers.get("authorization") ?? "";
  const hits = RELEASE_IDENTITIES.filter(identity => matches(supplied, process.env[identity.secretEnv]));
  if (hits.length === 0) throw new ReleaseError(401, "Unauthorized");
  // A shared secret would let one caller act as another; refuse instead of picking one.
  if (hits.length > 1) throw new ReleaseError(503, "Release identities are misconfigured");
  return hits[0];
}

export async function releaseAccess(request: Request, scope: ReleaseScope) {
  const identity = releaseIdentity(request);
  if (!identity.scopes.includes(scope)) throw new ReleaseError(403, "Forbidden for this release identity");
  const instagramId = process.env[identity.accountEnv];
  if (!instagramId) throw new ReleaseError(503, "Release account is not configured");
  // Two identities on one account would erase the isolation between them.
  if (RELEASE_IDENTITIES.some(other => other !== identity && process.env[other.accountEnv] === instagramId)) {
    throw new ReleaseError(503, "Release identities are misconfigured");
  }
  const account = await prisma.instagramAccount.findUnique({ where: { instagramId } });
  if (!account) throw new ReleaseError(503, "Release account is unavailable");
  if (account.provider !== "META") throw new ReleaseError(409, "Unsupported provider: META is required");
  return { identity, account, context: await createInstagramContext(account) };
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
