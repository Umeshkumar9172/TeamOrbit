import { randomUUID } from "node:crypto";
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
const testEmail = `phase2-${randomUUID()}@newtonite.local`;
const testPassword = "phase2-integration-password";

if (integrationTestsEnabled) {
describe("authentication integration", () => {
  let userId: string | undefined;
  let teamId: string | undefined;
  let prisma: ReturnType<typeof getPrisma> | undefined;

  function database() {
    if (!prisma) {
      throw new Error("Integration database was not initialized.");
    }
    return prisma;
  }

  beforeAll(async () => {
    prisma = getPrisma();
    await database().$connect();
    const passwordHash = await hashPassword(testPassword);
    const team = await database().team.create({
      data: {
        name: "Phase 2 Integration Team",
        slug: `phase2-${randomUUID()}`,
      },
    });
    teamId = team.id;
    const user = await database().user.create({
      data: { email: testEmail, name: "Integration User", passwordHash },
    });
    userId = user.id;
    await database().membership.create({
      data: { teamId: team.id, userId: user.id, role: "LEAD" },
    });
  });

  beforeEach(async () => {
    const userIds = validFixtureIds([userId]);
    if (userIds.length) {
      await database().session.deleteMany({ where: { userId: { in: userIds } } });
    }
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await cleanupIntegrationFixtures({
          teamIds: [teamId],
          userIds: [userId],
          deleteWorkItems: async () => {},
          deleteIdempotencyRecords: async () => {},
          deleteSessions: (userIds) =>
            database().session.deleteMany({ where: { userId: { in: userIds } } }),
          deleteUsers: (userIds) =>
            database().user.deleteMany({ where: { id: { in: userIds } } }),
          deleteTeams: (teamIds) =>
            database().team.deleteMany({ where: { id: { in: teamIds } } }),
        });
      }
    } finally {
      await disconnectPrisma();
    }
  });

  it("accepts valid credentials and returns a secure cookie without stored hashes", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .send({ email: testEmail.toUpperCase(), password: testPassword });

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe(testEmail);
    expect(response.body.user.passwordHash).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(response.body)).not.toContain("argon2");

    const setCookie = response.headers["set-cookie"]?.[0];
    if (!setCookie) {
      throw new Error("Login response did not set a session cookie.");
    }
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
    const token = setCookie.split(";")[0]?.split("=")[1];
    if (!token) {
      throw new Error("Session cookie did not contain a token.");
    }
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(response.body)).not.toContain(token);
    const storedSession = await database().session.findFirst({
      where: { userId },
    });
    expect(storedSession?.tokenHash).toHaveLength(64);
    expect(storedSession?.tokenHash).not.toBe(token);
  });

  it("rejects wrong and unknown credentials with a safe generic error", async () => {
    const wrongPassword = await request(app)
      .post("/api/auth/login")
      .send({ email: testEmail, password: "wrong-password" });
    const unknownEmail = await request(app)
      .post("/api/auth/login")
      .send({ email: `missing-${testEmail}`, password: "wrong-password" });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual({ error: "Invalid email or password." });
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it("validates login request input", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .send({ email: "not-an-email", password: "" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Email and password are required and must be valid.",
    });
  });

  it("sets the Secure cookie flag in production", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const response = await request(app)
        .post("/api/auth/login")
        .send({ email: testEmail, password: testPassword });
      expect(response.headers["set-cookie"]?.[0]).toContain("Secure");
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it("requires authentication for current user and returns team memberships", async () => {
    const unauthenticated = await request(app).get("/api/auth/me");
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: testEmail, password: testPassword });
    const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0];
    const currentUser = await request(app).get("/api/auth/me").set("Cookie", cookie ?? "");

    expect(unauthenticated.status).toBe(401);
    expect(currentUser.status).toBe(200);
    expect(currentUser.headers["cache-control"]).toBe("no-store");
    expect(currentUser.body.user.memberships).toEqual([
      {
        role: "LEAD",
        team: expect.objectContaining({ id: teamId, name: "Phase 2 Integration Team" }),
      },
    ]);
    expect(currentUser.body.user.passwordHash).toBeUndefined();
  });

  it("invalidates a session on logout", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: testEmail, password: testPassword });
    const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0];
    const logout = await request(app).post("/api/auth/logout").set("Cookie", cookie ?? "");
    const currentUser = await request(app).get("/api/auth/me").set("Cookie", cookie ?? "");

    expect(logout.status).toBe(204);
    expect(logout.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
    expect(currentUser.status).toBe(401);
    expect(await database().session.count({ where: { userId } })).toBe(0);
  });
});
} else {
  describe.skip("authentication integration (disabled)", () => {});
}
