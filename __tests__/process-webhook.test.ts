import { beforeEach, expect, it, vi } from "vitest";
const { db, queue, reads } = vi.hoisted(() => ({
  db: { instagramAccount: { findMany: vi.fn() }, webhookEvent: { create: vi.fn(), update: vi.fn() }, dmLog: { findMany: vi.fn() } },
  queue: vi.fn(), reads: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => ({ add: queue }), MESSAGE_JOB_NAME: "process-message", POSTBACK_JOB_NAME: "process-postback" }));
vi.mock("@/lib/meta/webhook", () => ({ parseCommentEvents: () => [], parseMessageEvents: () => [], parsePostbackEvents: () => [], parseReadEvents: reads }));
import { processInstagramWebhook } from "@/lib/queue/process-webhook";
beforeEach(() => {
  vi.clearAllMocks();
  db.instagramAccount.findMany.mockResolvedValue([{ id: "connection", instagramId: "native", workspaceId: "workspace" }]);
  db.webhookEvent.create.mockResolvedValue({ id: "webhook" });
  db.webhookEvent.update.mockResolvedValue({});
  db.dmLog.findMany.mockResolvedValue([{ id: "origin_old", automation: { id: "automation" } }, { id: "origin_new", automation: { id: "automation" } }]);
  reads.mockReturnValue([{ instagramAccountId: "native", userId: "viewer" }]);
});
it("schedules each original comment independently with account-bound source filtering", async () => {
  await processInstagramWebhook({ payload: { object: "instagram", entry: [{ id: "native", time: 1 }] }, provider: "META" });
  expect(queue).toHaveBeenCalledTimes(2);
  expect(queue.mock.calls.map(call => call[1].payload)).toEqual(["reveal:v1:automation:origin_old", "reveal:v1:automation:origin_new"]);
  expect(queue.mock.calls.map(call => call[2].jobId)).toEqual(["read_fallback_native_viewer_origin_old", "read_fallback_native_viewer_origin_new"]);
  expect(db.dmLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ instagramAccountId: "connection", status: "SENT", dmDeliveryUnconfirmed: false, postbackVersion: 1, NOT: [{ commentId: { startsWith: "reveal:" } }, { commentId: { startsWith: "dm:" } }] }) }));
});

it("does not schedule historical originals without versioned postback delivery", async () => {
  const historical = [{ id: "legacy", postbackVersion: null, automation: { id: "automation" } }];
  db.dmLog.findMany.mockImplementation(async ({ where }) => historical.filter(log => log.postbackVersion === where.postbackVersion));
  await processInstagramWebhook({ payload: { object: "instagram", entry: [{ id: "native", time: 1 }] }, provider: "META" });
  expect(queue).not.toHaveBeenCalled();
});
