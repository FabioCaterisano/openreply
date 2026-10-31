/**
 * Privacy retention: Instagram personal data older than 90 days is removed,
 * younger rows (the live dedup guards) stay untouched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;

const { tables } = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
}));

// Minimal in-memory evaluator for exactly the filters retention.ts uses.
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Where[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond === null) return value == null;
    if (typeof cond === "object" && cond !== null) {
      const c = cond as { lt?: Date; in?: string[]; not?: null };
      if ("lt" in c) return value instanceof Date && value < c.lt!;
      if ("in" in c) return c.in!.includes(value as string);
      if ("not" in c) return value != null;
    }
    return value === cond;
  });
}

function fakeModel(name: string) {
  return {
    findMany: vi.fn(async ({ where, take }: { where: Where; take: number }) =>
      tables[name].filter((r) => matches(r, where)).slice(0, take).map((r) => ({ id: r.id }))
    ),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const before = tables[name].length;
      tables[name] = tables[name].filter((r) => !matches(r, where));
      return { count: before - tables[name].length };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      let count = 0;
      for (const r of tables[name]) if (matches(r, where)) { Object.assign(r, data); count++; }
      return { count };
    }),
  };
}

const { mockPrisma } = vi.hoisted(() => ({ mockPrisma: {} as Record<string, unknown> }));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  PERSONAL_DATA_RETENTION_DAYS,
  purgeExpiredPersonalData,
  retentionCutoff,
} from "../lib/ops/retention";
import { MAX_POLL_LOOKBACK_HOURS, pollLookbackHours } from "../lib/polling/comment-reconciler";

const NOW = new Date("2026-10-31T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

beforeEach(() => {
  for (const name of ["dmLog", "webhookEvent", "operationalEvent", "processedComment", "postbackDelivery", "linkClick"]) {
    tables[name] = [];
    mockPrisma[name] = fakeModel(name);
  }
});

describe("purgeExpiredPersonalData", () => {
  it("deletes DM logs older than 90 days and keeps younger ones", async () => {
    tables.dmLog = [
      { id: "old", commentId: "c1", commenterId: "u1", createdAt: daysAgo(91), dropClaimUntil: null },
      { id: "edge", commentId: "c2", commenterId: "u2", createdAt: daysAgo(89), dropClaimUntil: null },
      { id: "new", commentId: "c3", commenterId: "u3", createdAt: daysAgo(1), dropClaimUntil: null },
    ];
    const result = await purgeExpiredPersonalData({ now: NOW });
    expect(result.dmLogsDeleted).toBe(1);
    expect(tables.dmLog.map((r) => r.id)).toEqual(["edge", "new"]);
  });

  it("works through a backlog in batches", async () => {
    tables.dmLog = Array.from({ length: 7 }, (_, i) => ({
      id: `old${i}`, createdAt: daysAgo(120), dropClaimUntil: null,
    }));
    const result = await purgeExpiredPersonalData({ now: NOW, batchSize: 3 });
    expect(result.dmLogsDeleted).toBe(7);
    expect(tables.dmLog).toEqual([]);
    const findMany = (mockPrisma.dmLog as ReturnType<typeof fakeModel>).findMany;
    expect(findMany).toHaveBeenCalledTimes(3);
    for (const [args] of findMany.mock.calls) expect(args.take).toBe(3);
  });

  it("leaves an old DM log alone while a worker holds a live drop claim on it", async () => {
    tables.dmLog = [
      { id: "claimed", createdAt: daysAgo(100), dropClaimUntil: new Date(NOW.getTime() + 60_000) },
      { id: "expiredClaim", createdAt: daysAgo(100), dropClaimUntil: daysAgo(99) },
    ];
    await purgeExpiredPersonalData({ now: NOW });
    expect(tables.dmLog.map((r) => r.id)).toEqual(["claimed"]);
  });

  it("deletes old webhook payloads, operational events, processed comments and postback claims", async () => {
    tables.webhookEvent = [
      { id: "w_old", createdAt: daysAgo(91) },
      { id: "w_new", createdAt: daysAgo(3) },
    ];
    tables.operationalEvent = [
      { id: "o_old", createdAt: daysAgo(200) },
      { id: "o_new", createdAt: daysAgo(10) },
    ];
    tables.processedComment = [
      { id: "p_old", seenAt: daysAgo(91) },
      { id: "p_new", seenAt: daysAgo(2) },
    ];
    tables.postbackDelivery = [
      { id: "b_old", createdAt: daysAgo(95) },
      { id: "b_new", createdAt: daysAgo(5) },
    ];
    const result = await purgeExpiredPersonalData({ now: NOW });
    expect(result).toMatchObject({
      webhookEventsDeleted: 1,
      operationalEventsDeleted: 1,
      processedCommentsDeleted: 1,
      postbackDeliveriesDeleted: 1,
    });
    expect(tables.webhookEvent.map((r) => r.id)).toEqual(["w_new"]);
    expect(tables.operationalEvent.map((r) => r.id)).toEqual(["o_new"]);
    expect(tables.processedComment.map((r) => r.id)).toEqual(["p_new"]);
    expect(tables.postbackDelivery.map((r) => r.id)).toEqual(["b_new"]);
  });

  it("keeps old link clicks for the counts but strips the visitor fields", async () => {
    tables.linkClick = [
      { id: "l_old", createdAt: daysAgo(91), ipHash: "h", userAgent: "UA", referrer: "r" },
      { id: "l_new", createdAt: daysAgo(1), ipHash: "h", userAgent: "UA", referrer: "r" },
    ];
    const result = await purgeExpiredPersonalData({ now: NOW });
    expect(result.linkClicksAnonymized).toBe(1);
    expect(tables.linkClick).toEqual([
      { id: "l_old", createdAt: daysAgo(91), ipHash: null, userAgent: null, referrer: null },
      { id: "l_new", createdAt: daysAgo(1), ipHash: "h", userAgent: "UA", referrer: "r" },
    ]);
    // Already anonymized rows are not touched again on the next run.
    const second = await purgeExpiredPersonalData({ now: NOW });
    expect(second.linkClicksAnonymized).toBe(0);
  });

  it("is a no-op when nothing is old enough", async () => {
    tables.dmLog = [{ id: "new", createdAt: daysAgo(1), dropClaimUntil: null }];
    const result = await purgeExpiredPersonalData({ now: NOW });
    expect(result.dmLogsDeleted).toBe(0);
    expect(tables.dmLog).toHaveLength(1);
  });
});

describe("idempotency is unchanged by retention", () => {
  it("the comment poll never looks back as far as the retention cutoff", () => {
    const furthestPollMs = MAX_POLL_LOOKBACK_HOURS * 60 * 60 * 1000;
    const retentionMs = NOW.getTime() - retentionCutoff(NOW).getTime();
    expect(retentionMs).toBe(PERSONAL_DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(furthestPollMs).toBeLessThan(retentionMs);
  });

  it("caps a misconfigured poll lookback at the 7-day private-reply window", () => {
    expect(pollLookbackHours(undefined)).toBe(72);
    expect(pollLookbackHours("24")).toBe(24);
    expect(pollLookbackHours(String(365 * 24))).toBe(MAX_POLL_LOOKBACK_HOURS);
    expect(pollLookbackHours("not-a-number")).toBe(72);
    expect(pollLookbackHours("0")).toBe(72);
  });
});
