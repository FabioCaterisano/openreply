import { beforeEach, afterEach, expect, it, vi } from "vitest";
const { db, queue } = vi.hoisted(() => ({ db: { upsert: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() }, queue: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { dmLog: db } }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => ({ add: queue }) }));
import { claimDropComment, dropRetryDelay, enqueuePendingDrops } from "@/lib/drops/pending";

const input = { workspaceId: "workspace", automationId: "automation", instagramAccountId: "connection", commenterId: "viewer", commentText: "DROP", commentId: "comment", mediaId: "media" };
let row: Record<string, unknown>;
function matches(where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "AND") return (expected as Record<string, unknown>[]).every(matches);
    if (key === "OR") return (expected as Record<string, unknown>[]).some(matches);
    const actual = row[key];
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
    if (expected && typeof expected === "object") {
      const ops = expected as Record<string, unknown>;
      return Object.entries(ops).every(([op, value]) => {
        if (op === "in") return (value as unknown[]).includes(actual);
        if (op === "lte") return actual instanceof Date && actual.getTime() <= (value as Date).getTime();
        if (op === "gt") return actual instanceof Date && actual.getTime() > (value as Date).getTime();
        return false;
      });
    }
    return actual === expected;
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
  row = { ...input, id: "origin", status: "PENDING", dmDeliveryUnconfirmed: false, dropPending: true, dropRetryAt: new Date(), dropRetryAttempts: 0, dropClaimToken: null, dropClaimUntil: null, instagramAccount: { instagramId: "native" } };
  db.upsert.mockReset().mockImplementation(async () => ({ ...row }));
  db.updateMany.mockReset().mockImplementation(async ({ where, data }) => {
    if (!matches(where)) return { count: 0 };
    for (const [key, value] of Object.entries(data)) {
      row[key] = value && typeof value === "object" && "increment" in value ? Number(row[key]) + Number(value.increment) : value;
    }
    return { count: 1 };
  });
  db.findMany.mockReset().mockImplementation(async () => [{ ...row }]);
  queue.mockReset().mockResolvedValue({});
});
afterEach(() => vi.useRealTimers());

it("atomically admits one of two original attempts and schedules fair backoff", async () => {
  const [first, second] = await Promise.all([claimDropComment(input), claimDropComment(input)]);
  expect(first).not.toBeNull();
  expect(second).toBeNull();
  await first!.assertOwned();
  await first!.finish();
  expect(row.dropClaimToken).toBeNull();
  expect(row.dropPending).toBe(true);
  expect(row.dropRetryAt).toEqual(new Date("2026-09-13T12:00:30Z"));
  expect(await claimDropComment(input)).toBeNull();
  expect([1, 2, 3, 8].map(dropRetryDelay)).toEqual([30_000, 60_000, 120_000, 300_000]);
});

it("shares the same lease between sweep dispatch and original deliveries", async () => {
  expect(await enqueuePendingDrops()).toBe(1);
  expect(await claimDropComment(input)).toBeNull();
  const dispatched = queue.mock.calls[0][1];
  expect(dispatched).toMatchObject({ automationId: "automation", accountConnectionId: "connection", instagramAccountId: "native", pendingClaimToken: row.dropClaimToken });
  const resumed = await claimDropComment(input, dispatched.pendingClaimToken);
  expect(resumed).not.toBeNull();
  expect(row.dropClaimToken).not.toBe(dispatched.pendingClaimToken);
  await resumed!.finish();
  expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ dropRetryAt: "asc" }, { id: "asc" }], take: 100 }));
});

it("exchanges a dispatch ticket once even when the same queue job executes twice", async () => {
  await enqueuePendingDrops();
  const dispatched = queue.mock.calls[0][1];
  const [first, duplicate] = await Promise.all([
    claimDropComment(input, dispatched.pendingClaimToken),
    claimDropComment(input, dispatched.pendingClaimToken),
  ]);
  expect(first).not.toBeNull();
  expect(duplicate).toBeNull();
  await first!.assertOwned();
  await first!.finish();
});

it("backfills retry source for a legacy credential failure before a metadata retry", async () => {
  Object.assign(row, { status: "FAILED", mediaId: null, originalMediaId: null, dropPending: false });
  const claim = await claimDropComment({ ...input, originalMediaId: "organic-post" });
  expect(claim!.log).toMatchObject({ mediaId: "media", originalMediaId: "organic-post" });
  // Metadata is still unavailable: finish without reaching the normal DM log update.
  await claim!.finish();
  vi.setSystemTime(new Date("2026-09-13T12:00:30Z"));
  expect(await enqueuePendingDrops()).toBe(1);
  expect(queue.mock.calls[0][1]).toMatchObject({ mediaId: "media", originalMediaId: "organic-post" });
});

it("preserves a previously captured retry source", async () => {
  row.originalMediaId = "bound-organic-post";
  const claim = await claimDropComment({ ...input, mediaId: "changed", originalMediaId: "changed" });
  expect(claim!.log).toMatchObject({ mediaId: "media", originalMediaId: "bound-organic-post" });
  await claim!.finish();
});

it("recovers after a dispatched job is lost and its lease expires", async () => {
  await enqueuePendingDrops();
  const oldToken = row.dropClaimToken as string;
  vi.setSystemTime(new Date("2026-09-13T12:06:00Z"));
  await enqueuePendingDrops();
  expect(row.dropClaimToken).not.toBe(oldToken);
  expect(await claimDropComment(input, oldToken)).toBeNull();
  const current = await claimDropComment(input, row.dropClaimToken as string);
  expect(current).not.toBeNull();
  await current!.finish();
});

it("clears dispatch leases after a queue error and leaves a durable due time", async () => {
  queue.mockRejectedValueOnce(new Error("redis unavailable"));
  await expect(enqueuePendingDrops()).rejects.toThrow("redis unavailable");
  expect(row).toMatchObject({ dropPending: true, dropClaimToken: null, dropClaimUntil: null });
  expect(row.dropRetryAt).toEqual(new Date("2026-09-13T12:00:30Z"));
});

it.each([{ status: "SENT" }, { dmDeliveryUnconfirmed: true }])("cannot claim sent or unconfirmed delivery %j", async state => {
  Object.assign(row, state);
  expect(await claimDropComment(input)).toBeNull();
});

it("clears pending state once delivery is complete and refuses an expired claim", async () => {
  const claim = await claimDropComment(input);
  row.dropClaimUntil = new Date("2026-09-13T11:59:00Z");
  await expect(claim!.assertOwned()).rejects.toThrow("Drop claim lost");
  row.status = "SENT";
  await claim!.finish();
  expect(row).toMatchObject({ dropPending: false, dropRetryAt: null, dropClaimToken: null });
});
