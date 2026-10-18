import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { requireAuthenticated } from "./auth.js";
import { getPrisma } from "./database.js";
import { Prisma } from "./generated/prisma/client.js";

const itemTypes = ["INCIDENT", "CUSTOMER_ISSUE", "PAYMENT", "COMPLIANCE", "TASK"] as const;
const priorities = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
const statuses = ["OPEN", "IN_PROGRESS", "AWAITING_APPROVAL", "RESOLVED", "CLOSED"] as const;
const nextStatus: Record<(typeof statuses)[number], (typeof statuses)[number] | null> = {
  OPEN: "IN_PROGRESS",
  IN_PROGRESS: "AWAITING_APPROVAL",
  AWAITING_APPROVAL: "RESOLVED",
  RESOLVED: "CLOSED",
  CLOSED: null,
};
const writeRoles = new Set(["MEMBER", "LEAD", "ADMIN"]);
const approvalRole = "LEAD";
const defaultPageSize = 25;
const maximumPageSize = 100;
const idempotencyTtlMs = 24 * 60 * 60 * 1000;

const uuidSchema = z.string().uuid();
const dateTimeSchema = z.string().datetime({ offset: true });
const createSchema = z
  .object({
    teamId: uuidSchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10_000),
    type: z.enum(itemTypes),
    priority: z.enum(priorities).optional(),
    assigneeId: uuidSchema.nullable().optional(),
    dueDate: dateTimeSchema.nullable().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    version: z.number().int().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10_000).optional(),
    type: z.enum(itemTypes).optional(),
    priority: z.enum(priorities).optional(),
    assigneeId: uuidSchema.nullable().optional(),
    dueDate: dateTimeSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (input) => Object.keys(input).some((key) => key !== "version"),
    "At least one editable field is required.",
  );

const transitionSchema = z
  .object({
    version: z.number().int().min(1),
    to: z.enum(statuses),
  })
  .strict();
const claimSchema = z.object({ version: z.number().int().min(1) }).strict();
const commentSchema = z
  .object({ body: z.string().trim().min(1).max(5000) })
  .strict();

const querySchema = z
  .object({
    status: z.enum(statuses).optional(),
    priority: z.enum(priorities).optional(),
    type: z.enum(itemTypes).optional(),
    assigneeId: z.union([uuidSchema, z.literal("unassigned")]).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .optional()
      .transform((value) => (value === undefined ? defaultPageSize : Number(value)))
      .pipe(z.number().int().min(1).max(maximumPageSize)),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

type CursorData = { createdAt: Date; id: string };

const itemSelection = {
  id: true,
  title: true,
  description: true,
  type: true,
  priority: true,
  status: true,
  teamId: true,
  assigneeId: true,
  creatorId: true,
  dueDate: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  team: { select: { id: true, name: true, slug: true } },
  assignee: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
} satisfies Prisma.WorkItemSelect;

export const itemsRouter = Router();

itemsRouter.use((_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
});
itemsRouter.use(requireAuthenticated);

itemsRouter.post("/", async (request: Request, response: Response) => {
  const input = createSchema.safeParse(request.body);
  if (!input.success) {
    response.status(400).json({ error: "Invalid work-item body." });
    return;
  }

  const userId = request.authenticatedUserId;
  if (!userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const prisma = getPrisma();
  const membership = await prisma.membership.findUnique({
    where: { teamId_userId: { teamId: input.data.teamId, userId } },
    select: { role: true },
  });
  if (!membership) {
    response.status(404).json({ error: "Team not found." });
    return;
  }
  if (!writeRoles.has(membership.role)) {
    response.status(403).json({ error: "You cannot create work items in this team." });
    return;
  }

  const key = request.get("Idempotency-Key");
  if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    response.status(400).json({ error: "A valid Idempotency-Key header is required." });
    return;
  }

  const fingerprint = createHash("sha256")
    .update(canonicalJson(input.data))
    .digest("hex");
  const existing = await prisma.idempotencyRecord.findUnique({
    where: { userId_key: { userId, key } },
  });
  if (existing && existing.expiresAt > new Date()) {
    const currentRole = await prisma.$transaction((tx) =>
      getLockedTeamRole(tx, input.data.teamId, userId),
    );
    if (!currentRole) {
      response.status(404).json({ error: "Team not found." });
      return;
    }
    if (!writeRoles.has(currentRole)) {
      response.status(403).json({ error: "You cannot create work items in this team." });
      return;
    }
    if (existing.fingerprint !== fingerprint) {
      response.status(409).json({
        error: "Idempotency key was already used with a different request.",
        code: "IDEMPOTENCY_KEY_REUSED",
      });
      return;
    }
    response.setHeader("Idempotency-Replayed", "true");
    response.status(201).json(existing.response);
    return;
  }
  if (existing) {
    await prisma.idempotencyRecord.deleteMany({
      where: { id: existing.id, expiresAt: { lte: new Date() } },
    });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentRole = await getLockedTeamRole(tx, input.data.teamId, userId);
      if (!currentRole) {
        return { kind: "missing-team" as const };
      }
      if (!writeRoles.has(currentRole)) {
        return { kind: "forbidden" as const };
      }
      if (input.data.assigneeId) {
        if (!(await getLockedTeamRole(tx, input.data.teamId, input.data.assigneeId))) {
          return { kind: "invalid-assignee" as const };
        }
      }

      await tx.idempotencyRecord.create({
        data: {
          userId,
          key,
          fingerprint,
          response: {},
          expiresAt: new Date(Date.now() + idempotencyTtlMs),
        },
      });
      const item = await tx.workItem.create({
        data: {
          teamId: input.data.teamId,
          creatorId: userId,
          title: input.data.title,
          description: input.data.description,
          type: input.data.type,
          priority: input.data.priority,
          assigneeId: input.data.assigneeId ?? null,
          dueDate: input.data.dueDate ? new Date(input.data.dueDate) : null,
        },
        select: itemSelection,
      });
      await recordMutation(tx, "ITEM_CREATED", item.id, userId, {
        status: item.status,
        priority: item.priority,
        assigneeId: item.assigneeId,
      });
      const storedResponse = JSON.parse(JSON.stringify({ item })) as Prisma.InputJsonValue;
      await tx.idempotencyRecord.update({
        where: { userId_key: { userId, key } },
        data: { response: storedResponse },
      });
      return { kind: "created" as const, response: storedResponse };
    });

    if (result.kind === "missing-team") {
      response.status(404).json({ error: "Team not found." });
      return;
    }
    if (result.kind === "forbidden") {
      response.status(403).json({ error: "You cannot create work items in this team." });
      return;
    }
    if (result.kind === "invalid-assignee") {
      response.status(400).json({ error: "Assignee must be a member of the selected team." });
      return;
    }
    response.status(201).json(result.response);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const replay = await prisma.idempotencyRecord.findUnique({
        where: { userId_key: { userId, key } },
      });
      if (replay && replay.expiresAt > new Date()) {
        if (replay.fingerprint !== fingerprint) {
          response.status(409).json({
            error: "Idempotency key was already used with a different request.",
            code: "IDEMPOTENCY_KEY_REUSED",
          });
          return;
        }
        response.setHeader("Idempotency-Replayed", "true");
        response.status(201).json(replay.response);
        return;
      }
    }
    throw error;
  }
});

itemsRouter.get("/", async (request: Request, response: Response) => {
  const input = querySchema.safeParse(request.query);
  if (!input.success) {
    response.status(400).json({ error: "Invalid work-item query parameters." });
    return;
  }

  const userId = request.authenticatedUserId;
  if (!userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const prisma = getPrisma();
  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: { teamId: true },
  });
  const teamIds = memberships.map(({ teamId }) => teamId);
  if (teamIds.length === 0) {
    response.status(200).json({ items: [], nextCursor: null });
    return;
  }

  let cursor: CursorData | undefined;
  if (input.data.cursor) {
    cursor = decodeCursor(input.data.cursor);
    if (!cursor) {
      response.status(400).json({ error: "Invalid work-item cursor." });
      return;
    }
    const cursorItem = await prisma.workItem.findFirst({
      where: { id: cursor.id, teamId: { in: teamIds } },
      select: { createdAt: true },
    });
    if (!cursorItem || cursorItem.createdAt.getTime() !== cursor.createdAt.getTime()) {
      response.status(400).json({ error: "Invalid work-item cursor." });
      return;
    }
  }

  const conditions: Prisma.WorkItemWhereInput[] = [];
  if (input.data.q) {
    conditions.push({
      OR: [
        { title: { contains: input.data.q, mode: "insensitive" } },
        { description: { contains: input.data.q, mode: "insensitive" } },
      ],
    });
  }
  if (cursor) {
    conditions.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }

  const items = await prisma.workItem.findMany({
    where: {
      teamId: { in: teamIds },
      ...(input.data.status ? { status: input.data.status } : {}),
      ...(input.data.priority ? { priority: input.data.priority } : {}),
      ...(input.data.type ? { type: input.data.type } : {}),
      ...(input.data.assigneeId
        ? { assigneeId: input.data.assigneeId === "unassigned" ? null : input.data.assigneeId }
        : {}),
      ...(conditions.length > 0 ? { AND: conditions } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.data.limit + 1,
    select: itemSelection,
  });

  const hasMore = items.length > input.data.limit;
  const pageItems = hasMore ? items.slice(0, input.data.limit) : items;
  const lastItem = pageItems.at(-1);
  response.status(200).json({
    items: pageItems,
    nextCursor: hasMore && lastItem ? encodeCursor(lastItem) : null,
  });
});

itemsRouter.get("/dashboard", async (request: Request, response: Response) => {
  const userId = request.authenticatedUserId;
  if (!userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }
  const prisma = getPrisma();
  const [assignedToMe, unassignedUrgent, awaitingMyApproval] = await Promise.all([
    prisma.workItem.findMany({
      where: {
        assigneeId: userId,
        team: { memberships: { some: { userId } } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 100,
      select: itemSelection,
    }),
    prisma.workItem.findMany({
      where: {
        assigneeId: null,
        priority: "URGENT",
        team: { memberships: { some: { userId } } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 100,
      select: itemSelection,
    }),
    prisma.workItem.findMany({
      where: {
        status: "AWAITING_APPROVAL",
        team: { memberships: { some: { userId, role: "LEAD" } } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 100,
      select: itemSelection,
    }),
  ]);
  response.status(200).json({ assignedToMe, unassignedUrgent, awaitingMyApproval });
});

itemsRouter.get("/:id", async (request: Request, response: Response) => {
  const id = uuidSchema.safeParse(request.params.id);
  if (!id.success) {
    response.status(400).json({ error: "Invalid work-item ID." });
    return;
  }

  const userId = request.authenticatedUserId;
  if (!userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const memberships = await getPrisma().membership.findMany({
    where: { userId },
    select: { teamId: true },
  });
  const item = await getPrisma().workItem.findFirst({
    where: { id: id.data, teamId: { in: memberships.map(({ teamId }) => teamId) } },
    select: itemSelection,
  });
  if (!item) {
    response.status(404).json({ error: "Work item not found." });
    return;
  }
  response.status(200).json({ item });
});

itemsRouter.patch("/:id", async (request: Request, response: Response) => {
  const id = uuidSchema.safeParse(request.params.id);
  if (!id.success) {
    response.status(400).json({ error: "Invalid work-item ID." });
    return;
  }
  const input = updateSchema.safeParse(request.body);
  if (!input.success) {
    response.status(400).json({ error: "Invalid work-item update body." });
    return;
  }

  const userId = request.authenticatedUserId;
  if (!userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const prisma = getPrisma();
  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: { teamId: true },
  });
  const item = await prisma.workItem.findFirst({
    where: { id: id.data, teamId: { in: memberships.map(({ teamId }) => teamId) } },
    select: { teamId: true },
  });
  if (!item) {
    response.status(404).json({ error: "Work item not found." });
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const role = await getLockedTeamRole(tx, item.teamId, userId);
    if (!role) {
      return { kind: "not-found" as const };
    }
    if (!writeRoles.has(role)) {
      return { kind: "forbidden" as const };
    }
    const before = await tx.workItem.findFirst({
      where: { id: id.data, teamId: item.teamId },
      select: { version: true, priority: true, assigneeId: true },
    });
    if (!before) {
      return { kind: "not-found" as const };
    }
    if (before.version !== input.data.version) {
      return { kind: "conflict" as const };
    }
    if (
      input.data.assigneeId &&
      !(await getLockedTeamRole(tx, item.teamId, input.data.assigneeId))
    ) {
      return { kind: "invalid-assignee" as const };
    }

    const changes = {
      ...(input.data.title !== undefined ? { title: input.data.title } : {}),
      ...(input.data.description !== undefined ? { description: input.data.description } : {}),
      ...(input.data.type !== undefined ? { type: input.data.type } : {}),
      ...(input.data.priority !== undefined ? { priority: input.data.priority } : {}),
      ...(input.data.assigneeId !== undefined ? { assigneeId: input.data.assigneeId } : {}),
      ...(input.data.dueDate !== undefined
        ? { dueDate: input.data.dueDate === null ? null : new Date(input.data.dueDate) }
        : {}),
    };
    const changed = await tx.workItem.updateMany({
      where: { id: id.data, teamId: item.teamId, version: input.data.version },
      data: { ...changes, version: { increment: 1 } },
    });
    if (changed.count !== 1) {
      return { kind: "conflict" as const };
    }
    const updated = await tx.workItem.findUnique({
      where: { id: id.data },
      select: itemSelection,
    });
    if (!updated) {
      throw new Error("Updated work item could not be read in its transaction.");
    }
    const beforeValues: Prisma.InputJsonObject = {
      ...(input.data.priority !== undefined ? { priority: before.priority } : {}),
      ...(input.data.assigneeId !== undefined ? { assigneeId: before.assigneeId } : {}),
    };
    const afterValues: Prisma.InputJsonObject = {
      ...(input.data.priority !== undefined ? { priority: updated.priority } : {}),
      ...(input.data.assigneeId !== undefined ? { assigneeId: updated.assigneeId } : {}),
    };
    await recordMutation(tx, "ITEM_UPDATED", updated.id, userId, {
      before: beforeValues,
      after: afterValues,
      changedFields: Object.keys(changes),
    });
    return { kind: "updated" as const, item: updated };
  });

  if (result.kind === "not-found") {
    response.status(404).json({ error: "Work item not found." });
    return;
  }
  if (result.kind === "forbidden") {
    response.status(403).json({ error: "You cannot update work items in this team." });
    return;
  }
  if (result.kind === "invalid-assignee") {
    response.status(400).json({ error: "Assignee must be a member of the item's team." });
    return;
  }
  if (result.kind === "conflict") {
    sendVersionConflict(response, id.data);
    return;
  }
  response.status(200).json({ item: result.item });
});

itemsRouter.post("/:id/transition", async (request: Request, response: Response) => {
  const id = uuidSchema.safeParse(request.params.id);
  const input = transitionSchema.safeParse(request.body);
  if (!id.success) {
    response.status(400).json({ error: "Invalid work-item ID." });
    return;
  }
  if (!input.success) {
    response.status(400).json({ error: "Invalid transition body." });
    return;
  }
  const userId = request.authenticatedUserId;
  if (!userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }
  const prisma = getPrisma();
  const scoped = await findScopedItem(prisma, id.data, userId);
  if (!scoped) {
    response.status(404).json({ error: "Work item not found." });
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const role = await getLockedTeamRole(tx, scoped.teamId, userId);
    if (!role) return { kind: "not-found" as const };
    if (!writeRoles.has(role)) return { kind: "forbidden" as const };
    const before = await tx.workItem.findFirst({
      where: { id: id.data, teamId: scoped.teamId },
      select: { status: true, version: true },
    });
    if (!before) return { kind: "not-found" as const };
    if (before.version !== input.data.version) return { kind: "conflict" as const };
    if (nextStatus[before.status] !== input.data.to) {
      return { kind: "invalid-transition" as const };
    }
    if (before.status === "AWAITING_APPROVAL" && role !== approvalRole) {
      return { kind: "approval-forbidden" as const };
    }

    const changed = await tx.workItem.updateMany({
      where: {
        id: id.data,
        teamId: scoped.teamId,
        version: input.data.version,
        status: before.status,
      },
      data: { status: input.data.to, version: { increment: 1 } },
    });
    if (changed.count !== 1) return { kind: "conflict" as const };
    const updated = await tx.workItem.findUnique({
      where: { id: id.data },
      select: itemSelection,
    });
    if (!updated) throw new Error("Transitioned work item could not be read in its transaction.");
    await recordMutation(tx, "STATUS_CHANGED", id.data, userId, {
      before: { status: before.status },
      after: { status: input.data.to },
    });
    return { kind: "transitioned" as const, item: updated };
  });

  if (result.kind === "not-found") {
    response.status(404).json({ error: "Work item not found." });
  } else if (result.kind === "forbidden") {
    response.status(403).json({ error: "You cannot transition work items in this team." });
  } else if (result.kind === "approval-forbidden") {
    response.status(403).json({ error: "A Lead of this team must approve this transition." });
  } else if (result.kind === "invalid-transition") {
    response.status(409).json({
      error: "The requested work-item status transition is not allowed.",
      code: "INVALID_STATUS_TRANSITION",
    });
  } else if (result.kind === "conflict") {
    sendVersionConflict(response, id.data);
  } else {
    response.status(200).json({ item: result.item });
  }
});

itemsRouter.post("/:id/claim", async (request: Request, response: Response) => {
  const id = uuidSchema.safeParse(request.params.id);
  const input = claimSchema.safeParse(request.body);
  if (!id.success) {
    response.status(400).json({ error: "Invalid work-item ID." });
    return;
  }
  if (!input.success) {
    response.status(400).json({ error: "Invalid claim body." });
    return;
  }
  const userId = request.authenticatedUserId;
  if (!userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }
  const prisma = getPrisma();
  const scoped = await findScopedItem(prisma, id.data, userId);
  if (!scoped) {
    response.status(404).json({ error: "Work item not found." });
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const role = await getLockedTeamRole(tx, scoped.teamId, userId);
    if (!role) return { kind: "not-found" as const };
    if (!writeRoles.has(role)) return { kind: "forbidden" as const };
    const before = await tx.workItem.findFirst({
      where: { id: id.data, teamId: scoped.teamId },
      select: { status: true, version: true, assigneeId: true },
    });
    if (!before) return { kind: "not-found" as const };
    if (before.version !== input.data.version) return { kind: "conflict" as const };
    if (before.status !== "OPEN" || before.assigneeId !== null) {
      return { kind: "ineligible" as const };
    }
    const changed = await tx.workItem.updateMany({
      where: {
        id: id.data,
        teamId: scoped.teamId,
        status: "OPEN",
        assigneeId: null,
        version: input.data.version,
      },
      data: { assigneeId: userId, version: { increment: 1 } },
    });
    if (changed.count !== 1) return { kind: "conflict" as const };
    const updated = await tx.workItem.findUnique({
      where: { id: id.data },
      select: itemSelection,
    });
    if (!updated) throw new Error("Claimed work item could not be read in its transaction.");
    await recordMutation(tx, "ASSIGNEE_CHANGED", id.data, userId, {
      before: { assigneeId: null },
      after: { assigneeId: userId },
      source: "claim",
    });
    return { kind: "claimed" as const, item: updated };
  });

  if (result.kind === "not-found") {
    response.status(404).json({ error: "Work item not found." });
  } else if (result.kind === "forbidden") {
    response.status(403).json({ error: "You cannot claim work items in this team." });
  } else if (result.kind === "ineligible") {
    response.status(409).json({
      error: "Only unassigned OPEN work items can be claimed.",
      code: "WORK_ITEM_NOT_CLAIMABLE",
    });
  } else if (result.kind === "conflict") {
    sendVersionConflict(response, id.data);
  } else {
    response.status(200).json({ item: result.item });
  }
});

itemsRouter.get("/:id/activity", async (request: Request, response: Response) => {
  const userId = request.authenticatedUserId;
  const id = uuidSchema.safeParse(request.params.id);
  if (!id.success) {
    response.status(400).json({ error: "Invalid work-item ID." });
    return;
  }
  if (!userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }
  const prisma = getPrisma();
  const events = await prisma.$transaction(async (tx) => {
    if (!(await findScopedItem(tx, id.data, userId))) return null;
    return tx.activityEvent.findMany({
      where: { workItemId: id.data },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        workItemId: true,
        actorId: true,
        eventType: true,
        metadata: true,
        createdAt: true,
        actor: { select: { id: true, name: true } },
      },
    });
  }, { isolationLevel: "RepeatableRead" });
  if (!events) {
    response.status(404).json({ error: "Work item not found." });
    return;
  }
  response.status(200).json({ events });
});

itemsRouter.get("/:id/comments", async (request: Request, response: Response) => {
  const userId = request.authenticatedUserId;
  const id = uuidSchema.safeParse(request.params.id);
  if (!id.success) {
    response.status(400).json({ error: "Invalid work-item ID." });
    return;
  }
  if (!userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }
  const prisma = getPrisma();
  const comments = await prisma.$transaction(async (tx) => {
    if (!(await findScopedItem(tx, id.data, userId))) return null;
    return tx.comment.findMany({
      where: { workItemId: id.data },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        workItemId: true,
        authorId: true,
        body: true,
        createdAt: true,
        author: { select: { id: true, name: true } },
      },
    });
  }, { isolationLevel: "RepeatableRead" });
  if (!comments) {
    response.status(404).json({ error: "Work item not found." });
    return;
  }
  response.status(200).json({ comments });
});

itemsRouter.post("/:id/comments", async (request: Request, response: Response) => {
  const userId = request.authenticatedUserId;
  const id = uuidSchema.safeParse(request.params.id);
  const input = commentSchema.safeParse(request.body);
  if (!id.success) {
    response.status(400).json({ error: "Invalid work-item ID." });
    return;
  }
  if (!input.success) {
    response.status(400).json({ error: "Invalid comment body." });
    return;
  }
  if (!userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }
  const prisma = getPrisma();
  const scoped = await findScopedItem(prisma, id.data, userId);
  if (!scoped) {
    response.status(404).json({ error: "Work item not found." });
    return;
  }
  const result = await prisma.$transaction(async (tx) => {
    const role = await getLockedTeamRole(tx, scoped.teamId, userId);
    if (!role) return { kind: "not-found" as const };
    if (!writeRoles.has(role)) return { kind: "forbidden" as const };
    const comment = await tx.comment.create({
      data: { workItemId: id.data, authorId: userId, body: input.data.body },
      select: {
        id: true,
        workItemId: true,
        authorId: true,
        body: true,
        createdAt: true,
        author: { select: { id: true, name: true } },
      },
    });
    await recordMutation(tx, "COMMENT_CREATED", id.data, userId, {
      commentId: comment.id,
    });
    return { kind: "created" as const, comment };
  });
  if (result.kind === "not-found") {
    response.status(404).json({ error: "Work item not found." });
  } else if (result.kind === "forbidden") {
    response.status(403).json({ error: "You cannot comment on work items in this team." });
  } else {
    response.status(201).json({ comment: result.comment });
  }
});

function encodeCursor(item: { id: string; createdAt: Date }): string {
  return Buffer.from(
    JSON.stringify({ id: item.id, createdAt: item.createdAt.toISOString() }),
  ).toString("base64url");
}

function decodeCursor(value: string): CursorData | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  try {
    const parsed = z
      .object({ id: uuidSchema, createdAt: dateTimeSchema })
      .strict()
      .safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (!parsed.success) {
      return undefined;
    }
    return { id: parsed.data.id, createdAt: new Date(parsed.data.createdAt) };
  } catch {
    return undefined;
  }
}

async function findScopedItem(
  prisma: ReturnType<typeof getPrisma> | Prisma.TransactionClient,
  id: string,
  userId: string,
) {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: { teamId: true },
  });
  if (memberships.length === 0) return null;
  return prisma.workItem.findFirst({
    where: { id, teamId: { in: memberships.map(({ teamId }) => teamId) } },
    select: { teamId: true },
  });
}

async function getLockedTeamRole(
  tx: Prisma.TransactionClient,
  teamId: string,
  userId: string,
): Promise<string | undefined> {
  const memberships = await tx.$queryRaw<Array<{ role: string }>>`
    SELECT "role"
    FROM "Membership"
    WHERE "teamId" = ${teamId}::uuid AND "userId" = ${userId}::uuid
    FOR SHARE
  `;
  return memberships[0]?.role;
}

async function recordMutation(
  tx: Prisma.TransactionClient,
  eventType: string,
  workItemId: string,
  actorId: string,
  metadata: Prisma.InputJsonObject,
): Promise<void> {
  const event = await tx.activityEvent.create({
    data: { workItemId, actorId, eventType, metadata },
    select: { id: true },
  });
  await tx.outboxJob.create({
    data: {
      workItemId,
      eventType,
      payload: { activityEventId: event.id, workItemId, actorId, eventType, metadata },
    },
  });
}

function sendVersionConflict(response: Response, id: string): void {
  response.status(409).json({
    error: "The work item has changed. Reload it and retry with the current version.",
    code: "VERSION_CONFLICT",
    reload: `/api/items/${id}`,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}
