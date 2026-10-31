/**
 * Personal-data retention (privacy policy: DM logs are kept for 90 days).
 *
 * Runs daily in the worker. Every row that carries Instagram personal data
 * (user id, username, comment/message text, raw webhook payload, pseudonymous
 * click data) and is older than the retention window is deleted, or for link
 * clicks stripped of the personal fields so aggregate click counts survive.
 *
 * Deletes run in small batches (select ids, delete by id) so a large backlog
 * never holds long locks or one huge transaction.
 *
 * Why deleting old DmLog rows cannot cause a second DM for the same comment:
 * - Webhooks: Meta retries a failed delivery for at most 36 hours, then drops
 *   it, so a comment is never delivered again 90 days later.
 * - Polling: the reconciler only reads comments from the last
 *   COMMENT_POLL_LOOKBACK_HOURS, capped at MAX_POLL_LOOKBACK_HOURS (7 days),
 *   far inside the 90-day window (see lib/polling/comment-reconciler.ts).
 * - Meta only accepts a private reply within 7 days of the comment, so even a
 *   replayed old comment could not be answered by DM.
 * Button taps whose origin log was deleted find no origin and send nothing
 * (processPostback returns early).
 */

import { prisma } from "@/lib/db/client";

export const PERSONAL_DATA_RETENTION_DAYS = 90;
export const RETENTION_BATCH_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionResult {
  cutoff: Date;
  dmLogsDeleted: number;
  webhookEventsDeleted: number;
  operationalEventsDeleted: number;
  processedCommentsDeleted: number;
  postbackDeliveriesDeleted: number;
  linkClicksAnonymized: number;
}

export function retentionCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - PERSONAL_DATA_RETENTION_DAYS * DAY_MS);
}

/** Select up to batchSize ids, apply the action to exactly those, repeat. */
async function inBatches(
  select: (take: number) => Promise<{ id: string }[]>,
  apply: (ids: string[]) => Promise<{ count: number }>,
  batchSize: number
): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await select(batchSize);
    if (rows.length === 0) break;
    const { count } = await apply(rows.map((r) => r.id));
    total += count;
    if (rows.length < batchSize) break;
  }
  return total;
}

export async function purgeExpiredPersonalData({
  now = new Date(),
  batchSize = RETENTION_BATCH_SIZE,
}: { now?: Date; batchSize?: number } = {}): Promise<RetentionResult> {
  const cutoff = retentionCutoff(now);

  const dmLogWhere = {
    createdAt: { lt: cutoff },
    // Never pull a row out from under a worker that holds a live drop claim.
    OR: [{ dropClaimUntil: null }, { dropClaimUntil: { lt: now } }],
  };
  const dmLogsDeleted = await inBatches(
    (take) => prisma.dmLog.findMany({ where: dmLogWhere, select: { id: true }, take }),
    (ids) => prisma.dmLog.deleteMany({ where: { id: { in: ids } } }),
    batchSize
  );

  const webhookEventsDeleted = await inBatches(
    (take) =>
      prisma.webhookEvent.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take,
      }),
    (ids) => prisma.webhookEvent.deleteMany({ where: { id: { in: ids } } }),
    batchSize
  );

  const operationalEventsDeleted = await inBatches(
    (take) =>
      prisma.operationalEvent.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take,
      }),
    (ids) => prisma.operationalEvent.deleteMany({ where: { id: { in: ids } } }),
    batchSize
  );

  const processedCommentsDeleted = await inBatches(
    (take) =>
      prisma.processedComment.findMany({
        where: { seenAt: { lt: cutoff } },
        select: { id: true },
        take,
      }),
    (ids) => prisma.processedComment.deleteMany({ where: { id: { in: ids } } }),
    batchSize
  );

  const postbackDeliveriesDeleted = await inBatches(
    (take) =>
      prisma.postbackDelivery.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take,
      }),
    (ids) => prisma.postbackDelivery.deleteMany({ where: { id: { in: ids } } }),
    batchSize
  );

  // Clicks feed the campaign and report counts, so the row stays and only the
  // pseudonymous visitor fields are cleared.
  const linkClicksAnonymized = await inBatches(
    (take) =>
      prisma.linkClick.findMany({
        where: {
          createdAt: { lt: cutoff },
          OR: [
            { ipHash: { not: null } },
            { userAgent: { not: null } },
            { referrer: { not: null } },
          ],
        },
        select: { id: true },
        take,
      }),
    (ids) =>
      prisma.linkClick.updateMany({
        where: { id: { in: ids } },
        data: { ipHash: null, userAgent: null, referrer: null },
      }),
    batchSize
  );

  return {
    cutoff,
    dmLogsDeleted,
    webhookEventsDeleted,
    operationalEventsDeleted,
    processedCommentsDeleted,
    postbackDeliveriesDeleted,
    linkClicksAnonymized,
  };
}
