import { createHash, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "./app.js";
import { disconnectPrisma, getPrisma } from "./database.js";
import { hashPassword } from "./password.js";
import { runOutboxOnce } from "./outbox-worker.js";
import {
  databaseIntegrationTestsAreEnabled,
  cleanupIntegrationFixtures,
  validFixtureIds,
} from "./integration-test-safety.js";

const integrationTestsEnabled = databaseIntegrationTestsAreEnabled(process.env);
const cookieName = "newtonite_session";

if (integrationTestsEnabled) {
describe("Phase 4 PostgreSQL acceptance", () => {
  const prisma = integrationTestsEnabled ? getPrisma() : undefined;
  const database = () => {
    if (!prisma) throw new Error("Integration database was not initialized.");
    return prisma;
  };
  const ids = {
    member: "",
    viewer: "",
    lead: "",
    teamBMember: "",
    teamBLead: "",
    teamA: "",
    teamB: "",
  };
  const userIds = () => [
    ids.member,
    ids.viewer,
    ids.lead,
    ids.teamBMember,
    ids.teamBLead,
  ];
  const emails = Object.fromEntries(
    ["member", "viewer", "lead", "teamBMember", "teamBLead"].map((key) => [
      key,
      `phase4-${key}-${randomUUID()}@newtonite.local`,
    ]),
  ) as Record<keyof Pick<typeof ids, "member" | "viewer" | "lead" | "teamBMember" | "teamBLead">, string>;

  async function cookieFor(userId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await database().session.create({
      data: {
        userId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return `${cookieName}=${token}`;
  }

  async function createItem(
    cookie: string,
    overrides: Record<string, unknown> = {},
    key = randomUUID(),
  ) {
    return request(app)
      .post("/api/items")
      .set("Cookie", cookie)
      .set("Idempotency-Key", key)
      .send({
        teamId: ids.teamA,
        title: "Phase 4 item",
        description: "Operational test item",
        type: "TASK",
        ...overrides,
      });
  }

  async function makeAwaitingApproval(
    cookie: string,
    overrides: Record<string, unknown> = {},
  ) {
    const created = await createItem(cookie, overrides);
    expect(created.status).toBe(201);
    const inProgress = await request(app)
      .post(`/api/items/${created.body.item.id}/transition`)
      .set("Cookie", cookie)
      .send({ version: 1, to: "IN_PROGRESS" });
    const awaiting = await request(app)
      .post(`/api/items/${created.body.item.id}/transition`)
      .set("Cookie", cookie)
      .send({ version: 2, to: "AWAITING_APPROVAL" });
    expect(inProgress.status).toBe(200);
    expect(awaiting.status).toBe(200);
    return awaiting.body.item as { id: string; version: number; status: string };
  }

  beforeAll(async () => {
    await database().$connect();
    const passwordHash = await hashPassword("phase4-test-password");
    const teamA = await database().team.create({
      data: { name: "Phase 4 A", slug: `phase4-a-${randomUUID()}` },
    });
    ids.teamA = teamA.id;
    const teamB = await database().team.create({
      data: { name: "Phase 4 B", slug: `phase4-b-${randomUUID()}` },
    });
    ids.teamB = teamB.id;
    for (const [key, email] of Object.entries(emails) as Array<
      [keyof typeof emails, string]
    >) {
      const user = await database().user.create({
        data: { email, name: `Phase 4 ${key}`, passwordHash },
      });
      ids[key] = user.id;
    }
    await database().membership.createMany({
      data: [
        { teamId: ids.teamA, userId: ids.member, role: "MEMBER" },
        { teamId: ids.teamA, userId: ids.viewer, role: "VIEWER" },
        { teamId: ids.teamA, userId: ids.lead, role: "LEAD" },
        { teamId: ids.teamB, userId: ids.teamBMember, role: "MEMBER" },
        { teamId: ids.teamB, userId: ids.teamBLead, role: "LEAD" },
        { teamId: ids.teamB, userId: ids.member, role: "VIEWER" },
      ],
    });
  });

  beforeEach(async () => {
    const teamIds = validFixtureIds([ids.teamA, ids.teamB]);
    const createdUserIds = validFixtureIds(userIds());
    if (teamIds.length) {
      await database().workItem.deleteMany({ where: { teamId: { in: teamIds } } });
    }
    if (createdUserIds.length) {
      await database().idempotencyRecord.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await database().session.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
    }
  });

  afterAll(async () => {
    try {
      await cleanupIntegrationFixtures({
        teamIds: [ids.teamA, ids.teamB],
        userIds: userIds(),
        deleteWorkItems: (teamIds) =>
          database().workItem.deleteMany({ where: { teamId: { in: teamIds } } }),
        deleteIdempotencyRecords: (createdUserIds) =>
          database().idempotencyRecord.deleteMany({
            where: { userId: { in: createdUserIds } },
          }),
        deleteSessions: (createdUserIds) =>
          database().session.deleteMany({ where: { userId: { in: createdUserIds } } }),
        deleteUsers: (createdUserIds) =>
          database().user.deleteMany({ where: { id: { in: createdUserIds } } }),
        deleteTeams: (teamIds) =>
          database().team.deleteMany({ where: { id: { in: teamIds } } }),
      });
    } finally {
      await disconnectPrisma();
    }
  });

  it("enforces every forward workflow transition and rejects invalid transitions", async () => {
    const memberCookie = await cookieFor(ids.member);
    const leadCookie = await cookieFor(ids.lead);
    const created = await createItem(memberCookie);
    const skipped = await request(app)
      .post(`/api/items/${created.body.item.id}/transition`)
      .set("Cookie", memberCookie)
      .send({ version: 1, to: "AWAITING_APPROVAL" });
    expect(skipped.status).toBe(409);
    expect(skipped.body.code).toBe("INVALID_STATUS_TRANSITION");

    const first = await request(app)
      .post(`/api/items/${created.body.item.id}/transition`)
      .set("Cookie", memberCookie)
      .send({ version: 1, to: "IN_PROGRESS" });
    const second = await request(app)
      .post(`/api/items/${created.body.item.id}/transition`)
      .set("Cookie", memberCookie)
      .send({ version: 2, to: "AWAITING_APPROVAL" });
    const denied = await request(app)
      .post(`/api/items/${created.body.item.id}/transition`)
      .set("Cookie", memberCookie)
      .send({ version: 3, to: "RESOLVED" });
    const approved = await request(app)
      .post(`/api/items/${created.body.item.id}/transition`)
      .set("Cookie", leadCookie)
      .send({ version: 3, to: "RESOLVED" });
    const closed = await request(app)
      .post(`/api/items/${created.body.item.id}/transition`)
      .set("Cookie", leadCookie)
      .send({ version: 4, to: "CLOSED" });
    const reopened = await request(app)
      .post(`/api/items/${created.body.item.id}/transition`)
      .set("Cookie", leadCookie)
      .send({ version: 5, to: "OPEN" });

    expect([first.status, second.status, denied.status, approved.status, closed.status, reopened.status])
      .toEqual([200, 200, 403, 200, 200, 409]);
    expect(reopened.body.code).toBe("INVALID_STATUS_TRANSITION");
    expect(closed.body.item).toMatchObject({ status: "CLOSED", version: 5 });
    expect(
      await database().workItem.findUnique({
        where: { id: created.body.item.id },
        select: { version: true },
      }),
    ).toEqual({ version: 5 });
  });

  it("checks every status/target pair against the workflow transition table", async () => {
    const leadCookie = await cookieFor(ids.lead);
    const created = await createItem(leadCookie);
    const allowed: Record<string, string> = {
      OPEN: "IN_PROGRESS",
      IN_PROGRESS: "AWAITING_APPROVAL",
      AWAITING_APPROVAL: "RESOLVED",
      RESOLVED: "CLOSED",
    };
    const statuses = [
      "OPEN",
      "IN_PROGRESS",
      "AWAITING_APPROVAL",
      "RESOLVED",
      "CLOSED",
    ] as const;

    for (const current of statuses) {
      for (const target of statuses) {
        await database().workItem.update({
          where: { id: created.body.item.id },
          data: { status: current, version: 1 },
        });
        const transition = await request(app)
          .post(`/api/items/${created.body.item.id}/transition`)
          .set("Cookie", leadCookie)
          .send({ version: 1, to: target });
        if (allowed[current] === target) {
          expect(transition.status).toBe(200);
          expect(transition.body.item).toMatchObject({ status: target, version: 2 });
        } else {
          expect(transition.status).toBe(409);
          expect(transition.body.code).toBe("INVALID_STATUS_TRANSITION");
          expect(await database().workItem.findUnique({
            where: { id: created.body.item.id },
            select: { status: true, version: true },
          })).toEqual({ status: current, version: 1 });
        }
      }
    }
  });

  it("allows exactly one of two concurrent transitions with the same version", async () => {
    const memberCookie = await cookieFor(ids.member);
    const created = await createItem(memberCookie);
    expect(created.status).toBe(201);
    const { id, version, status } = created.body.item as {
      id: string;
      version: number;
      status: string;
    };
    expect({ version, status }).toEqual({ version: 1, status: "OPEN" });

    const transitions = await Promise.all([
      request(app)
        .post(`/api/items/${id}/transition`)
        .set("Cookie", memberCookie)
        .send({ version, to: "IN_PROGRESS" }),
      request(app)
        .post(`/api/items/${id}/transition`)
        .set("Cookie", memberCookie)
        .send({ version, to: "IN_PROGRESS" }),
    ]);

    expect(transitions.map(({ status: httpStatus }) => httpStatus).sort()).toEqual([200, 409]);
    const successfulTransition = transitions.find(({ status: httpStatus }) => httpStatus === 200);
    expect(successfulTransition?.body.item).toMatchObject({
      id,
      status: "IN_PROGRESS",
      version: version + 1,
    });
    const persisted = await database().workItem.findUnique({
      where: { id },
      select: { status: true, version: true },
    });
    expect(persisted).toEqual({ status: "IN_PROGRESS", version: version + 1 });

    const statusEvents = await database().activityEvent.findMany({
      where: { workItemId: id, eventType: "STATUS_CHANGED" },
      select: { actorId: true, metadata: true },
    });
    expect(statusEvents).toEqual([
      {
        actorId: ids.member,
        metadata: {
          before: { status: "OPEN" },
          after: { status: "IN_PROGRESS" },
        },
      },
    ]);
  });

  it("does not accept approval from a Lead of another team", async () => {
    const memberCookie = await cookieFor(ids.member);
    const otherLeadCookie = await cookieFor(ids.teamBLead);
    const item = await makeAwaitingApproval(memberCookie);
    const response = await request(app)
      .post(`/api/items/${item.id}/transition`)
      .set("Cookie", otherLeadCookie)
      .send({ version: item.version, to: "RESOLVED" });
    expect(response.status).toBe(404);
    expect(await database().workItem.findUnique({ where: { id: item.id }, select: { status: true } }))
      .toEqual({ status: "AWAITING_APPROVAL" });
  });

  it("allows exactly one concurrent claim and increments version once", async () => {
    const memberCookie = await cookieFor(ids.member);
    const leadCookie = await cookieFor(ids.lead);
    const created = await createItem(memberCookie);
    const claims = await Promise.all([
      request(app)
        .post(`/api/items/${created.body.item.id}/claim`)
        .set("Cookie", memberCookie)
        .send({ version: 1 }),
      request(app)
        .post(`/api/items/${created.body.item.id}/claim`)
        .set("Cookie", leadCookie)
        .send({ version: 1 }),
    ]);
    const persisted = await database().workItem.findUnique({
      where: { id: created.body.item.id },
      select: { assigneeId: true, version: true },
    });
    expect(claims.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(persisted).toMatchObject({ version: 2 });
    expect([ids.member, ids.lead]).toContain(persisted?.assigneeId);
    expect(await database().activityEvent.count({
      where: { workItemId: created.body.item.id, eventType: "ASSIGNEE_CHANGED" },
    })).toBe(1);
  });

  it("denies Viewer claims and refuses items outside the claimable state", async () => {
    const memberCookie = await cookieFor(ids.member);
    const viewerCookie = await cookieFor(ids.viewer);
    const created = await createItem(memberCookie);
    const viewerClaim = await request(app)
      .post(`/api/items/${created.body.item.id}/claim`)
      .set("Cookie", viewerCookie)
      .send({ version: 1 });
    const transition = await request(app)
      .post(`/api/items/${created.body.item.id}/transition`)
      .set("Cookie", memberCookie)
      .send({ version: 1, to: "IN_PROGRESS" });
    const ineligible = await request(app)
      .post(`/api/items/${created.body.item.id}/claim`)
      .set("Cookie", memberCookie)
      .send({ version: 2 });
    expect(viewerClaim.status).toBe(403);
    expect(transition.status).toBe(200);
    expect(ineligible.status).toBe(409);
    expect(ineligible.body.code).toBe("WORK_ITEM_NOT_CLAIMABLE");
    expect(await database().workItem.findUnique({
      where: { id: created.body.item.id },
      select: { status: true, assigneeId: true, version: true },
    })).toEqual({ status: "IN_PROGRESS", assigneeId: null, version: 2 });
  });

  it("enforces optimistic locking for updates, including concurrent stale requests", async () => {
    const cookie = await cookieFor(ids.member);
    const created = await createItem(cookie);
    const [first, second] = await Promise.all([
      request(app)
        .patch(`/api/items/${created.body.item.id}`)
        .set("Cookie", cookie)
        .send({ version: 1, title: "Concurrent title" }),
      request(app)
        .patch(`/api/items/${created.body.item.id}`)
        .set("Cookie", cookie)
        .send({ version: 1, priority: "HIGH" }),
    ]);
    const success = first.status === 200 ? first : second;
    const conflict = first.status === 409 ? first : second;
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(conflict.body).toMatchObject({
      code: "VERSION_CONFLICT",
      reload: `/api/items/${created.body.item.id}`,
    });
    expect(success.body.item.version).toBe(2);

    const stale = await request(app)
      .patch(`/api/items/${created.body.item.id}`)
      .set("Cookie", cookie)
      .send({ version: 1, title: "Stale title" });
    expect(stale.status).toBe(409);
    expect(
      await database().workItem.findUnique({
        where: { id: created.body.item.id },
        select: { version: true },
      }),
    ).toEqual({ version: 2 });
  });

  it("replays a create for the same key and payload and rejects changed payloads", async () => {
    const cookie = await cookieFor(ids.member);
    const missingKey = await request(app).post("/api/items").set("Cookie", cookie).send({
      teamId: ids.teamA,
      title: "No idempotency key",
      description: "Rejected create",
      type: "TASK",
    });
    const key = randomUUID();
    const first = await createItem(cookie, { title: "Idempotent title" }, key);
    const replay = await createItem(cookie, { title: "Idempotent title" }, key);
    const changed = await createItem(cookie, { title: "Different title" }, key);
    expect(missingKey.status).toBe(400);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.body.item.id).toBe(first.body.item.id);
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await database().workItem.count({ where: { teamId: ids.teamA } })).toBe(1);
  });

  it("creates one item for concurrent duplicate idempotent requests", async () => {
    const cookie = await cookieFor(ids.member);
    const key = randomUUID();
    const results = await Promise.all([
      createItem(cookie, { title: "Concurrent idempotency" }, key),
      createItem(cookie, { title: "Concurrent idempotency" }, key),
    ]);
    expect(results.map(({ status }) => status)).toEqual([201, 201]);
    expect(results[0].body.item.id).toBe(results[1].body.item.id);
    expect(await database().workItem.count({ where: { teamId: ids.teamA } })).toBe(1);
  });

  it("scopes identical idempotency keys independently per authenticated user", async () => {
    const memberCookie = await cookieFor(ids.member);
    const leadCookie = await cookieFor(ids.lead);
    const key = randomUUID();
    const memberCreate = await createItem(memberCookie, { title: "Member request" }, key);
    const leadCreate = await createItem(leadCookie, { title: "Lead request" }, key);
    expect(memberCreate.status).toBe(201);
    expect(leadCreate.status).toBe(201);
    expect(leadCreate.body.item.id).not.toBe(memberCreate.body.item.id);
  });

  it("rolls back the create and idempotency record when the database rejects creation", async () => {
    const cookie = await cookieFor(ids.member);
    const key = randomUUID();
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `phase4_reject_${suffix}`;
    const triggerName = `phase4_reject_trigger_${suffix}`;
    await database().$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."title" = 'phase4-database-failure' THEN
          RAISE EXCEPTION 'test create rejection';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await database().$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "WorkItem"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    try {
      const failed = await createItem(cookie, { title: "phase4-database-failure" }, key);
      expect(failed.status).toBe(500);
      expect(await database().idempotencyRecord.count({
        where: { userId: ids.member, key },
      })).toBe(0);
      expect(await database().workItem.count({
        where: { teamId: ids.teamA, title: "phase4-database-failure" },
      })).toBe(0);
    } finally {
      await database().$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "WorkItem"`);
      await database().$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  });

  it("rolls back a work-item update and activity when outbox insertion fails", async () => {
    const cookie = await cookieFor(ids.member);
    const created = await createItem(cookie);
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `phase4_fail_outbox_${suffix}`;
    const triggerName = `phase4_fail_outbox_trigger_${suffix}`;
    await database().$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."eventType" = 'ITEM_UPDATED' THEN
          RAISE EXCEPTION 'test outbox rejection';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await database().$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "OutboxJob"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    try {
      const failed = await request(app)
        .patch(`/api/items/${created.body.item.id}`)
        .set("Cookie", cookie)
        .send({ version: 1, priority: "URGENT" });
      expect(failed.status).toBe(500);
      expect(await database().workItem.findUnique({
        where: { id: created.body.item.id },
        select: { priority: true, version: true },
      })).toEqual({ priority: "NORMAL", version: 1 });
      expect(await database().activityEvent.count({
        where: { workItemId: created.body.item.id },
      })).toBe(1);
      expect(await database().outboxJob.count({
        where: { workItemId: created.body.item.id },
      })).toBe(1);
    } finally {
      await database().$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "OutboxJob"`);
      await database().$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  });

  it("writes transactional activity for successful changes and no event for rejected changes", async () => {
    const memberCookie = await cookieFor(ids.member);
    const otherTeamCookie = await cookieFor(ids.teamBMember);
    const created = await createItem(memberCookie);
    const beforeCount = await database().activityEvent.count({ where: { workItemId: created.body.item.id } });
    const rejected = await request(app)
      .post(`/api/items/${created.body.item.id}/transition`)
      .set("Cookie", memberCookie)
      .send({ version: 1, to: "RESOLVED" });
    const updated = await request(app)
      .patch(`/api/items/${created.body.item.id}`)
      .set("Cookie", memberCookie)
      .send({ version: 1, priority: "URGENT" });
    const unauthorized = await request(app)
      .get(`/api/items/${created.body.item.id}/activity`)
      .set("Cookie", otherTeamCookie);
    const events = await request(app)
      .get(`/api/items/${created.body.item.id}/activity`)
      .set("Cookie", memberCookie);
    expect(rejected.status).toBe(409);
    expect(updated.status).toBe(200);
    expect(unauthorized.status).toBe(404);
    expect(events.status).toBe(200);
    expect(events.body.events).toHaveLength(beforeCount + 1);
    expect(events.body.events.find((event: { eventType: string }) => event.eventType === "ITEM_UPDATED"))
      .toMatchObject({
      actorId: ids.member,
      eventType: "ITEM_UPDATED",
      metadata: { before: { priority: "NORMAL" }, after: { priority: "URGENT" } },
      });
    expect(
      await request(app)
        .patch(`/api/items/${created.body.item.id}/activity/${events.body.events[0].id}`)
        .set("Cookie", memberCookie)
        .send({ eventType: "EDITED" }),
    ).toMatchObject({ status: 404 });
    expect(await database().outboxJob.count({ where: { workItemId: created.body.item.id } }))
      .toBe(beforeCount + 1);
  });

  it("creates and lists validated team-scoped comments with matching activity", async () => {
    const memberCookie = await cookieFor(ids.member);
    const otherTeamCookie = await cookieFor(ids.teamBMember);
    const created = await createItem(memberCookie);
    const invalid = await request(app)
      .post(`/api/items/${created.body.item.id}/comments`)
      .set("Cookie", memberCookie)
      .send({ body: "   " });
    const tooLong = await request(app)
      .post(`/api/items/${created.body.item.id}/comments`)
      .set("Cookie", memberCookie)
      .send({ body: "x".repeat(5001) });
    const crossTeam = await request(app)
      .post(`/api/items/${created.body.item.id}/comments`)
      .set("Cookie", otherTeamCookie)
      .send({ body: "not allowed" });
    const comment = await request(app)
      .post(`/api/items/${created.body.item.id}/comments`)
      .set("Cookie", memberCookie)
      .send({ body: "Customer contacted; follow-up arranged." });
    const list = await request(app)
      .get(`/api/items/${created.body.item.id}/comments`)
      .set("Cookie", memberCookie);
    const hidden = await request(app)
      .get(`/api/items/${created.body.item.id}/comments`)
      .set("Cookie", otherTeamCookie);
    expect([invalid.status, tooLong.status, crossTeam.status]).toEqual([400, 400, 404]);
    expect(comment.status).toBe(201);
    expect(list.body.comments).toHaveLength(1);
    expect(list.body.comments[0]).toMatchObject({
      authorId: ids.member,
      body: "Customer contacted; follow-up arranged.",
    });
    expect(hidden.status).toBe(404);
    expect(
      await database().activityEvent.findFirst({
        where: { workItemId: created.body.item.id, eventType: "COMMENT_CREATED" },
        select: { metadata: true },
      }),
    ).toMatchObject({ metadata: { commentId: comment.body.comment.id } });
  });

  it("returns dashboard results filtered by memberships and Lead role in PostgreSQL", async () => {
    const memberCookie = await cookieFor(ids.member);
    const leadCookie = await cookieFor(ids.lead);
    const memberB = await cookieFor(ids.teamBMember);
    const assigned = await createItem(memberCookie, { assigneeId: ids.member });
    const urgent = await createItem(memberCookie, { priority: "URGENT" });
    const awaitingA = await makeAwaitingApproval(memberCookie);
    const teamBItem = await createItem(memberB, {
      teamId: ids.teamB,
      title: "Team B urgent",
      priority: "URGENT",
    });
    const teamBAwaiting = await makeAwaitingApproval(memberB, { teamId: ids.teamB });
    const memberDashboard = await request(app).get("/api/items/dashboard").set("Cookie", memberCookie);
    const leadDashboard = await request(app).get("/api/items/dashboard").set("Cookie", leadCookie);
    expect(memberDashboard.status).toBe(200);
    expect(memberDashboard.body.assignedToMe.map((item: { id: string }) => item.id))
      .toContain(assigned.body.item.id);
    expect(memberDashboard.body.unassignedUrgent.map((item: { id: string }) => item.id))
      .toContain(urgent.body.item.id);
    expect(memberDashboard.body.unassignedUrgent.map((item: { id: string }) => item.id))
      .toContain(teamBItem.body.item.id);
    expect(memberDashboard.body.awaitingMyApproval).toHaveLength(0);
    expect(leadDashboard.body.awaitingMyApproval.map((item: { id: string }) => item.id))
      .toContain(awaitingA.id);
    expect(leadDashboard.body.awaitingMyApproval.map((item: { id: string }) => item.id))
      .not.toContain(teamBAwaiting.id);
    expect(leadDashboard.body.unassignedUrgent.map((item: { id: string }) => item.id))
      .not.toContain(teamBItem.body.item.id);
  });

  it("retries failed jobs with bounded attempts and makes failures observable", async () => {
    const cookie = await cookieFor(ids.member);
    const created = await createItem(cookie);
    const job = await database().outboxJob.findFirst({
      where: { workItemId: created.body.item.id },
      orderBy: { createdAt: "asc" },
    });
    if (!job) throw new Error("Creation did not enqueue an outbox job.");
    await database().outboxJob.updateMany({
      where: { workItemId: created.body.item.id, id: { not: job.id } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await database().outboxJob.update({
      where: { id: job.id },
      data: { payload: { invalid: true } },
    });
    const failingHandler = async () => {
      throw new Error("deliberate retry test");
    };
    await runOutboxOnce({
      handler: failingHandler,
      maxAttempts: 2,
      baseDelayMs: 75,
      maximumDelayMs: 75,
    });
    const retry = await database().outboxJob.findUnique({ where: { id: job.id } });
    expect(retry).toMatchObject({
      status: "PENDING",
      attempts: 1,
      lastError: "handler_failed:Error",
    });
    expect(retry?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 80));
    await runOutboxOnce({
      handler: failingHandler,
      maxAttempts: 2,
      baseDelayMs: 75,
      maximumDelayMs: 75,
    });
    const failed = await database().outboxJob.findUnique({ where: { id: job.id } });
    expect(failed).toMatchObject({ status: "FAILED", attempts: 2 });
  });

  it("claims outbox jobs once across concurrent workers and does not reprocess completed jobs", async () => {
    const cookie = await cookieFor(ids.member);
    const created = await createItem(cookie);
    const job = await database().outboxJob.findFirst({
      where: { workItemId: created.body.item.id },
      orderBy: { createdAt: "asc" },
    });
    if (!job) throw new Error("Creation did not enqueue an outbox job.");
    await database().outboxJob.updateMany({
      where: { workItemId: created.body.item.id, id: { not: job.id } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    let calls = 0;
    const handler = async () => {
      calls += 1;
    };
    const simultaneous = await Promise.all([
      runOutboxOnce({ handler }),
      runOutboxOnce({ handler }),
    ]);
    expect(simultaneous.sort()).toEqual([0, 1]);
    expect(calls).toBe(1);
    const repeated = await runOutboxOnce({ handler });
    expect(repeated).toBe(0);
    expect(calls).toBe(1);
    expect(await database().outboxJob.findUnique({
      where: { id: job.id },
      select: { status: true, attempts: true },
    })).toEqual({ status: "COMPLETED", attempts: 1 });
  });

  it("acknowledges a valid activity event through the built-in worker handler", async () => {
    const cookie = await cookieFor(ids.member);
    const created = await createItem(cookie);
    const job = await database().outboxJob.findFirst({
      where: { workItemId: created.body.item.id },
      orderBy: { createdAt: "asc" },
    });
    if (!job) throw new Error("Creation did not enqueue an outbox job.");
    await database().outboxJob.updateMany({
      where: { workItemId: created.body.item.id, id: { not: job.id } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    expect(await runOutboxOnce({ batchSize: 1 })).toBe(1);
    expect(await database().outboxJob.findUnique({
      where: { id: job.id },
      select: { status: true, attempts: true, lastError: true },
    })).toEqual({ status: "COMPLETED", attempts: 1, lastError: null });
  });
});
} else {
  describe.skip("Phase 4 PostgreSQL acceptance (disabled)", () => {});
}
