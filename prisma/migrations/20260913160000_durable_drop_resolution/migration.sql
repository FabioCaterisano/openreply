ALTER TABLE "DmLog"
  ADD COLUMN "expectedDropNumber" INTEGER,
  ADD COLUMN "dropPending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "dropRetryAt" TIMESTAMP(3),
  ADD COLUMN "dropRetryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dropClaimToken" TEXT,
  ADD COLUMN "dropClaimUntil" TIMESTAMP(3),
  ADD COLUMN "originalMediaId" TEXT,
  ADD COLUMN "postbackVersion" INTEGER;

-- Existing originals deliberately retain NULL: their recipient-level reveal
-- history cannot be safely converted into per-origin read fallback deliveries.

CREATE INDEX "DmLog_dropPending_dropRetryAt_idx" ON "DmLog"("dropPending", "dropRetryAt");
