-- CreateEnum
CREATE TYPE "WorkItemType" AS ENUM ('INCIDENT', 'CUSTOMER_ISSUE', 'PAYMENT', 'COMPLIANCE', 'TASK');

-- CreateEnum
CREATE TYPE "WorkItemPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "WorkItemStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED');

-- CreateTable
CREATE TABLE "WorkItem" (
    "id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL,
    "type" "WorkItemType" NOT NULL,
    "priority" "WorkItemPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "WorkItemStatus" NOT NULL DEFAULT 'OPEN',
    "teamId" UUID NOT NULL,
    "assigneeId" UUID,
    "creatorId" UUID NOT NULL,
    "dueDate" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkItem_teamId_createdAt_id_idx" ON "WorkItem"("teamId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "WorkItem_teamId_status_idx" ON "WorkItem"("teamId", "status");

-- CreateIndex
CREATE INDEX "WorkItem_teamId_priority_idx" ON "WorkItem"("teamId", "priority");

-- CreateIndex
CREATE INDEX "WorkItem_teamId_type_idx" ON "WorkItem"("teamId", "type");

-- CreateIndex
CREATE INDEX "WorkItem_teamId_assigneeId_idx" ON "WorkItem"("teamId", "assigneeId");

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
