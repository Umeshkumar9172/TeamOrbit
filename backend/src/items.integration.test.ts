import { createHash, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "./database.js";
import { app } from "./app.js";
import { hashPassword } from "./password.js";
import {
  databaseIntegrationTestsAreEnabled,
  cleanupIntegrationFixtures,
  validFixtureIds,
} from "./integration-test-safety.js";

const integrationTestsEnabled = databaseIntegrationTestsAreEnabled(process.env);
const testPassword = "phase3-integration-password";
const cookieName = "newtonite_session";

if (integrationTestsEnabled) {
describe("work-item integration", () => {
  const prisma = integrationTestsEnabled ? getPrisma() : undefined;
  const database = () => {
    if (!prisma) throw new Error("Integration database was not initialized.");
    return prisma;
  };
  const ids = {
    member: "",
    viewer: "",
    lead: "",
    admin: "",
    teamBMember: "",
    teamA: "",
    teamB: "",
  };
  const emails = {
    member: `phase3-member-${randomUUID()}@newtonite.local`,
    viewer: `phase3-viewer-${randomUUID()}@newtonite.local`,
    lead: `phase3-lead-${randomUUID()}@newtonite.local`,
    admin: `phase3-admin-${randomUUID()}@newtonite.local`,
    teamBMember: `phase3-team-b-${randomUUID()}@newtonite.local`,
  };

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
  ) {
    return request(app)
      .post("/api/items")
      .set("Cookie", cookie)
      .set("Idempotency-Key", randomUUID())
      .send({
        teamId: ids.teamA,
        title: "Initial item",
        description: "Initial description",
        type: "TASK",
        ...overrides,
      });
  }

  async function createTeamBItem() {
    const cookie = await cookieFor(ids.teamBMember);
    const response = await createItem(cookie, { teamId: ids.teamB, title: "Private team B item" });
    expect(response.status).toBe(201);
    return response.body.item as { id: string; title: string; priority: string; version: number };
  }

  beforeAll(async () => {
    await database().$connect();
    const passwordHash = await hashPassword(testPassword);
    const teamA = await database().team.create({
      data: { name: "Phase 3 Team A", slug: `phase3-a-${randomUUID()}` },
    });
    ids.teamA = teamA.id;
    const teamB = await database().team.create({
      data: { name: "Phase 3 Team B", slug: `phase3-b-${randomUUID()}` },
    });
    ids.teamB = teamB.id;

    for (const [key, email] of Object.entries(emails) as Array<
      [keyof typeof emails, string]
    >) {
      const user = await database().user.create({
        data: { email, name: `Phase 3 ${key}`, passwordHash },
      });
      ids[key] = user.id;
    }

    await database().membership.createMany({
      data: [
        { teamId: ids.teamA, userId: ids.member, role: "MEMBER" },
        { teamId: ids.teamB, userId: ids.member, role: "VIEWER" },
        { teamId: ids.teamA, userId: ids.viewer, role: "VIEWER" },
        { teamId: ids.teamA, userId: ids.lead, role: "LEAD" },
        { teamId: ids.teamA, userId: ids.admin, role: "ADMIN" },
        { teamId: ids.teamB, userId: ids.teamBMember, role: "MEMBER" },
      ],
    });
  });

  beforeEach(async () => {
    const teamIds = validFixtureIds([ids.teamA, ids.teamB]);
    const userIds = validFixtureIds([
      ids.member, ids.viewer, ids.lead, ids.admin, ids.teamBMember,
    ]);
    if (teamIds.length) {
      await database().workItem.deleteMany({ where: { teamId: { in: teamIds } } });
    }
    if (userIds.length) {
      await database().session.deleteMany({ where: { userId: { in: userIds } } });
    }
  });

  afterAll(async () => {
    try {
      await cleanupIntegrationFixtures({
        teamIds: [ids.teamA, ids.teamB],
        userIds: [ids.member, ids.viewer, ids.lead, ids.admin, ids.teamBMember],
        deleteWorkItems: (teamIds) =>
          database().workItem.deleteMany({ where: { teamId: { in: teamIds } } }),
        deleteIdempotencyRecords: (userIds) =>
          database().idempotencyRecord.deleteMany({ where: { userId: { in: userIds } } }),
        deleteSessions: (userIds) =>
          database().session.deleteMany({ where: { userId: { in: userIds } } }),
        deleteUsers: (userIds) =>
          database().user.deleteMany({ where: { id: { in: userIds } } }),
        deleteTeams: (teamIds) =>
          database().team.deleteMany({ where: { id: { in: teamIds } } }),
      });
    } finally {
      await disconnectPrisma();
    }
  });

  it("rejects unauthenticated list, create, read, and update requests", async () => {
    const itemId = randomUUID();
    const create = await request(app).post("/api/items").send({
      teamId: ids.teamA,
      title: "Unauthenticated",
      description: "",
      type: "TASK",
    });
    const list = await request(app).get("/api/items");
    const read = await request(app).get(`/api/items/${itemId}`);
    const update = await request(app).patch(`/api/items/${itemId}`).send({ title: "Changed" });

    expect([create.status, list.status, read.status, update.status]).toEqual([401, 401, 401, 401]);
    expect(create.body).toEqual({ error: "Authentication required." });
  });

  it("allows a team member to create and read an item, with server-controlled fields", async () => {
    const cookie = await cookieFor(ids.member);
    const created = await createItem(cookie, {
      title: "Printer outage",
      description: "Unable to print",
      type: "INCIDENT",
      priority: "HIGH",
      assigneeId: ids.lead,
    });
    expect(created.status).toBe(201);
    expect(created.body.item).toMatchObject({
      teamId: ids.teamA,
      creatorId: ids.member,
      assigneeId: ids.lead,
      status: "OPEN",
      version: 1,
      priority: "HIGH",
      type: "INCIDENT",
    });

    const detail = await request(app)
      .get(`/api/items/${created.body.item.id}`)
      .set("Cookie", cookie);
    const list = await request(app).get("/api/items").set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.item.id).toBe(created.body.item.id);
    expect(list.body.items.map((item: { id: string }) => item.id)).toContain(created.body.item.id);
  });

  it("denies Viewer writes and leaves the existing item unchanged", async () => {
    const memberCookie = await cookieFor(ids.member);
    const viewerCookie = await cookieFor(ids.viewer);
    const created = await createItem(memberCookie);

    const create = await createItem(viewerCookie, { title: "Viewer attempt" });
    const update = await request(app)
      .patch(`/api/items/${created.body.item.id}`)
      .set("Cookie", viewerCookie)
      .send({ version: 1, title: "Viewer changed this" });
    const persisted = await database().workItem.findUnique({
      where: { id: created.body.item.id },
      select: { title: true, version: true },
    });

    expect(create.status).toBe(403);
    expect(update.status).toBe(403);
    expect(persisted).toEqual({ title: "Initial item", version: 1 });
  });

  it.each([
    ["LEAD", "lead"],
    ["ADMIN", "admin"],
  ])("%s can create and update an item in its own team", async (_role, userKey) => {
    const cookie = await cookieFor(ids[userKey as "lead" | "admin"]);
    const created = await createItem(cookie, { title: `${_role} item` });
    const updated = await request(app)
      .patch(`/api/items/${created.body.item.id}`)
      .set("Cookie", cookie)
      .send({ version: 1, priority: "URGENT" });

    expect(created.status).toBe(201);
    expect(updated.status).toBe(200);
    expect(updated.body.item.priority).toBe("URGENT");
  });

  it("applies the Team B Viewer role rather than the Team A Member role", async () => {
    const cookie = await cookieFor(ids.member);
    const viewerCookie = await cookieFor(ids.viewer);
    const privateItem = await createTeamBItem();

    const create = await createItem(cookie, { teamId: ids.teamB, title: "Cross-team create" });
    const read = await request(app).get(`/api/items/${privateItem.id}`).set("Cookie", cookie);
    const update = await request(app)
      .patch(`/api/items/${privateItem.id}`)
      .set("Cookie", cookie)
      .send({ version: 1, title: "Cross-team update" });
    const unmemberRead = await request(app)
      .get(`/api/items/${privateItem.id}`)
      .set("Cookie", viewerCookie);
    const list = await request(app).get("/api/items").set("Cookie", viewerCookie);
    const persisted = await database().workItem.findUnique({
      where: { id: privateItem.id },
      select: { title: true, version: true },
    });

    expect(create.status).toBe(403);
    expect(read.status).toBe(200);
    expect(read.body.item.id).toBe(privateItem.id);
    expect(update.status).toBe(403);
    expect(unmemberRead.status).toBe(404);
    expect(list.body.items.map((item: { id: string }) => item.id)).not.toContain(privateItem.id);
    expect(persisted).toEqual({ title: "Private team B item", version: 1 });
  });

  it("hides a team's existence when the caller has no membership", async () => {
    const viewerCookie = await cookieFor(ids.viewer);
    const privateItem = await createTeamBItem();
    const create = await createItem(viewerCookie, { teamId: ids.teamB });
    const update = await request(app)
      .patch(`/api/items/${privateItem.id}`)
      .set("Cookie", viewerCookie)
      .send({ version: 1, title: "Unauthorized update" });

    expect(create.status).toBe(404);
    expect(create.body).toEqual({ error: "Team not found." });
    expect(update.status).toBe(404);
    expect(update.body).toEqual({ error: "Work item not found." });
  });

  it("validates assignees on create and update without mutating rejected changes", async () => {
    const cookie = await cookieFor(ids.member);
    const crossTeamCreate = await createItem(cookie, { assigneeId: ids.teamBMember });
    const created = await createItem(cookie, { assigneeId: ids.lead });
    const crossTeamUpdate = await request(app)
      .patch(`/api/items/${created.body.item.id}`)
      .set("Cookie", cookie)
      .send({ version: 1, assigneeId: ids.teamBMember });
    const invalidAssignee = await createItem(cookie, { assigneeId: randomUUID() });
    const persisted = await database().workItem.findUnique({
      where: { id: created.body.item.id },
      select: { assigneeId: true },
    });

    expect(crossTeamCreate.status).toBe(400);
    expect(crossTeamUpdate.status).toBe(400);
    expect(invalidAssignee.status).toBe(400);
    expect(persisted?.assigneeId).toBe(ids.lead);
  });

  it("validates bodies, IDs, enums, filters, and pagination parameters", async () => {
    const cookie = await cookieFor(ids.member);
    const invalidBody = await createItem(cookie, { type: "UNKNOWN" });
    const invalidDate = await createItem(cookie, { dueDate: "not-a-date" });
    const unknownField = await createItem(cookie, { creatorId: ids.admin });
    const invalidId = await request(app).get("/api/items/not-a-uuid").set("Cookie", cookie);
    const invalidStatus = await request(app).get("/api/items?status=BOGUS").set("Cookie", cookie);
    const invalidPriority = await request(app).get("/api/items?priority=BOGUS").set("Cookie", cookie);
    const invalidType = await request(app).get("/api/items?type=BOGUS").set("Cookie", cookie);
    const invalidAssignee = await request(app)
      .get("/api/items?assigneeId=not-a-uuid")
      .set("Cookie", cookie);
    const invalidLimit = await request(app).get("/api/items?limit=101").set("Cookie", cookie);
    const unknownQuery = await request(app).get("/api/items?unexpected=value").set("Cookie", cookie);

    expect(invalidBody.status).toBe(400);
    expect(invalidDate.status).toBe(400);
    expect(unknownField.status).toBe(400);
    expect(invalidId.status).toBe(400);
    expect(invalidStatus.status).toBe(400);
    expect(invalidPriority.status).toBe(400);
    expect(invalidType.status).toBe(400);
    expect(invalidAssignee.status).toBe(400);
    expect(invalidLimit.status).toBe(400);
    expect(unknownQuery.status).toBe(400);
    expect(await database().workItem.count({ where: { teamId: ids.teamA } })).toBe(0);
  });

  it("supports status, priority, type, assignee, unassigned, and case-insensitive text filters", async () => {
    const cookie = await cookieFor(ids.member);
    const matching = await createItem(cookie, {
      title: "Critical Payment failure",
      description: "Payment processor unavailable",
      type: "PAYMENT",
      priority: "URGENT",
      assigneeId: ids.lead,
    });
    await createItem(cookie, { title: "Routine task", type: "TASK", priority: "LOW" });

    const filtered = await request(app)
      .get(`/api/items?status=OPEN&priority=URGENT&type=PAYMENT&assigneeId=${ids.lead}&q=payment`)
      .set("Cookie", cookie);
    const unassigned = await request(app)
      .get("/api/items?assigneeId=unassigned")
      .set("Cookie", cookie);

    expect(filtered.status).toBe(200);
    expect(filtered.body.items.map((item: { id: string }) => item.id)).toEqual([
      matching.body.item.id,
    ]);
    expect(unassigned.body.items).toHaveLength(1);
    expect(unassigned.body.items[0].assigneeId).toBeNull();
  });

  it("paginates in stable createdAt/id order without duplicates", async () => {
    const cookie = await cookieFor(ids.member);
    await Promise.all(
      ["A", "B", "C", "D", "E"].map((suffix) =>
        createItem(cookie, { title: `Page item ${suffix}` }),
      ),
    );

    const first = await request(app).get("/api/items?limit=2").set("Cookie", cookie);
    const second = await request(app)
      .get(`/api/items?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set("Cookie", cookie);
    const third = await request(app)
      .get(`/api/items?limit=2&cursor=${encodeURIComponent(second.body.nextCursor)}`)
      .set("Cookie", cookie);
    const all = await request(app).get("/api/items?limit=100").set("Cookie", cookie);
    const pagedIds = [
      ...first.body.items.map((item: { id: string }) => item.id),
      ...second.body.items.map((item: { id: string }) => item.id),
      ...third.body.items.map((item: { id: string }) => item.id),
    ];

    expect(first.body.items).toHaveLength(2);
    expect(second.body.items).toHaveLength(2);
    expect(third.body.items).toHaveLength(1);
    expect(new Set(pagedIds).size).toBe(5);
    expect(pagedIds).toEqual(all.body.items.map((item: { id: string }) => item.id));
    expect(third.body.nextCursor).toBeNull();
    expect(
      await request(app).get("/api/items?cursor=bad-cursor").set("Cookie", cookie),
    ).toMatchObject({ status: 400 });
  });

  it("allows only documented editable fields and keeps server-owned fields unchanged", async () => {
    const cookie = await cookieFor(ids.member);
    const created = await createItem(cookie, { assigneeId: ids.lead });
    const before = await database().workItem.findUnique({ where: { id: created.body.item.id } });
    const changes = [
      { id: randomUUID() },
      { creatorId: ids.admin },
      { teamId: ids.teamB },
      { status: "CLOSED" },
      { version: 100 },
      { createdAt: new Date().toISOString() },
      { updatedAt: new Date().toISOString() },
    ];
    const rejected = await Promise.all(
      changes.map((body) =>
        request(app)
          .patch(`/api/items/${created.body.item.id}`)
          .set("Cookie", cookie)
          .send(body),
      ),
    );
    const after = await database().workItem.findUnique({ where: { id: created.body.item.id } });
    const updated = await request(app)
      .patch(`/api/items/${created.body.item.id}`)
      .set("Cookie", cookie)
      .send({
        version: 1,
        title: "Revised title",
        description: "Revised description",
        type: "INCIDENT",
        priority: "HIGH",
        assigneeId: null,
        dueDate: "2026-11-01T12:00:00.000Z",
      });

    expect(rejected.every((response) => response.status === 400)).toBe(true);
    expect(after).toEqual(before);
    expect(updated.status).toBe(200);
    expect(updated.body.item).toMatchObject({
      id: created.body.item.id,
      creatorId: ids.member,
      teamId: ids.teamA,
      status: "OPEN",
      version: 2,
      title: "Revised title",
      assigneeId: null,
    });
  });
});
} else {
  describe.skip("work-item integration (disabled)", () => {});
}
