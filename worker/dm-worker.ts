import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import os from "node:os";
import { enqueuePendingDrops } from "@/lib/drops/pending";
import { purgeExpiredPersonalData } from "@/lib/ops/retention";

const worker = createDMWorker();
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);

console.log("[DM Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  try {
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

let pendingSweepRunning = false;
async function sweepPendingDrops() {
  if (pendingSweepRunning) return;
  pendingSweepRunning = true;
  try { await enqueuePendingDrops(); }
  catch (error) { console.error("[DM Worker] Pending drop sweep failed", error instanceof Error ? error.message : "Unknown error"); }
  finally { pendingSweepRunning = false; }
}
void sweepPendingDrops();
const dropTimer = setInterval(() => void sweepPendingDrops(), 30_000);

// Privacy retention: delete Instagram personal data older than 90 days. Once
// shortly after boot (deploys restart the worker), then daily.
const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
let retentionRunning = false;
async function purgeRetention() {
  if (retentionRunning) return;
  retentionRunning = true;
  try {
    const r = await purgeExpiredPersonalData();
    console.log(
      `[DM Worker] Retention purge (before ${r.cutoff.toISOString()}): ` +
        `dmLog=${r.dmLogsDeleted} webhookEvent=${r.webhookEventsDeleted} ` +
        `operationalEvent=${r.operationalEventsDeleted} processedComment=${r.processedCommentsDeleted} ` +
        `postbackDelivery=${r.postbackDeliveriesDeleted} linkClickAnonymized=${r.linkClicksAnonymized}`
    );
  } catch (error) {
    console.error("[DM Worker] Retention purge failed", error instanceof Error ? error.message : "Unknown error");
  } finally {
    retentionRunning = false;
  }
}
setTimeout(() => void purgeRetention(), 60_000);
const retentionTimer = setInterval(() => void purgeRetention(), RETENTION_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  clearInterval(dropTimer);
  clearInterval(retentionTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
