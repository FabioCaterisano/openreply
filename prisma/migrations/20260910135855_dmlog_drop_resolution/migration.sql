-- AlterTable
ALTER TABLE "DmLog" ADD COLUMN     "dropNumber" INTEGER,
ADD COLUMN     "dropSlug" TEXT,
ADD COLUMN     "dropUrl" TEXT,
ADD COLUMN     "mediaId" TEXT;

-- CreateIndex
CREATE INDEX "DmLog_automationId_commenterId_createdAt_idx" ON "DmLog"("automationId", "commenterId", "createdAt");
