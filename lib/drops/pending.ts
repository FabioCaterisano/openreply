import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { getDMQueue, type ProcessCommentJob } from "@/lib/queue/client";
import type { Prisma } from "@/app/generated/prisma/client";

const LEASE_MS = 5 * 60_000;
const retryable = { status: { in: ["PENDING", "FAILED"] as ("PENDING" | "FAILED")[] }, dmDeliveryUnconfirmed: false };

export function dropRetryDelay(attempt: number): number {
  return Math.min(300_000, 30_000 * 2 ** Math.min(4, Math.max(0, attempt - 1)));
}

export async function claimDropComment(data: Prisma.DmLogUncheckedCreateInput, dispatchToken?: string) {
  const log = await prisma.dmLog.upsert({
    where: { automationId_commentId: { automationId: data.automationId, commentId: data.commentId } },
    create: { ...data, dropPending: true, dropRetryAt: new Date() }, update: {},
  });
  const now = new Date();
  // Dispatch tokens are single-use tickets, not execution ownership. A stalled
  // BullMQ job may run twice; only one execution can exchange the ticket.
  const token = randomUUID();
  const retrySource = {
    ...(!log.mediaId && data.mediaId ? { mediaId: data.mediaId } : {}),
    ...(!log.originalMediaId && data.originalMediaId ? { originalMediaId: data.originalMediaId } : {}),
  };
  const claimed = await prisma.dmLog.updateMany({ where: {
    id: log.id, ...retryable,
    ...(dispatchToken ? { dropClaimToken: dispatchToken, dropClaimUntil: { gt: now } } : { AND: [
      { OR: [{ dropClaimUntil: null }, { dropClaimUntil: { lte: now } }] },
      { OR: [{ dropRetryAt: null }, { dropRetryAt: { lte: now } }] },
    ] }),
  }, data: { ...retrySource, dropPending: true, dropClaimToken: token, dropClaimUntil: new Date(now.getTime() + LEASE_MS), dropRetryAttempts: { increment: 1 } } });
  if (!claimed.count) return null;
  let lost = false;
  const renew = setInterval(() => {
    void prisma.dmLog.updateMany({ where: { id: log.id, dropClaimToken: token }, data: { dropClaimUntil: new Date(Date.now() + LEASE_MS) } })
      .then(r => { if (!r.count) lost = true; }).catch(() => { lost = true; });
  }, 30_000);
  renew.unref();
  return {
    log: { ...log, ...retrySource },
    async assertOwned() {
      if (lost) throw new Error("Drop claim lost");
      const owned = await prisma.dmLog.updateMany({ where: { id: log.id, dropClaimToken: token, dropClaimUntil: { gt: new Date() }, ...retryable }, data: { dropClaimUntil: new Date(Date.now() + LEASE_MS) } });
      if (!owned.count) throw new Error("Drop claim lost");
    },
    async finish() {
      clearInterval(renew);
      // Due-time ordering keeps an unavailable old reel from starving newer rows.
      await prisma.dmLog.updateMany({ where: { id: log.id, dropClaimToken: token, ...retryable }, data: {
        dropClaimToken: null, dropClaimUntil: null, dropRetryAt: new Date(Date.now() + dropRetryDelay(log.dropRetryAttempts + 1)),
      } });
      await prisma.dmLog.updateMany({ where: { id: log.id, dropClaimToken: token }, data: { dropPending: false, dropClaimToken: null, dropClaimUntil: null, dropRetryAt: null } });
    },
  };
}

export async function enqueuePendingDrops(): Promise<number> {
  const now = new Date();
  const logs = await prisma.dmLog.findMany({ where: {
    dropPending: true, ...retryable, dropRetryAt: { lte: now },
    OR: [{ dropClaimUntil: null }, { dropClaimUntil: { lte: now } }],
    automation: { isActive: true },
  }, orderBy: [{ dropRetryAt: "asc" }, { id: "asc" }], take: 100,
    include: { instagramAccount: { select: { instagramId: true } } },
  });
  let queued = 0;
  for (const log of logs) {
    if (!log.mediaId) continue;
    // Original jobs and sweep dispatches acquire the same lease. The queued job
    // must present this token; crashes become eligible when the lease expires.
    const token = randomUUID();
    const dispatched = await prisma.dmLog.updateMany({ where: { id: log.id, ...retryable, dropPending: true, dropRetryAt: log.dropRetryAt,
      OR: [{ dropClaimUntil: null }, { dropClaimUntil: { lte: now } }],
    }, data: { dropClaimToken: token, dropClaimUntil: new Date(now.getTime() + LEASE_MS) } });
    if (!dispatched.count) continue;
    const data: ProcessCommentJob = {
      instagramAccountId: log.instagramAccount.instagramId, accountConnectionId: log.instagramAccountId,
      automationId: log.automationId, commentId: log.commentId, commentText: log.commentText,
      pendingClaimToken: token,
      commenterId: log.commenterId, commenterName: log.commenterName ?? undefined,
      mediaId: log.mediaId, originalMediaId: log.originalMediaId ?? undefined,
    };
    try {
      await getDMQueue().add("process-comment", data, { jobId: `drop_${log.id}_${token}`, removeOnComplete: true, removeOnFail: true });
    } catch (error) {
      await prisma.dmLog.updateMany({ where: { id: log.id, dropClaimToken: token }, data: { dropClaimToken: null, dropClaimUntil: null, dropRetryAt: new Date(Date.now() + 30_000) } });
      throw error;
    }
    queued++;
  }
  return queued;
}
