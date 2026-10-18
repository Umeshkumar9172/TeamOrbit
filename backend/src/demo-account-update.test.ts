import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyDemoAccountUpdates,
  assertDemoAccountEnvironment,
  assertDemoDatabaseIdentity,
  DemoAccountSafetyError,
  demoAccountMappings,
  previewDemoAccountUpdates,
  type DemoAccountIdentity,
  type DemoAccountStore,
  type LocalDatabaseIdentity,
} from "./demo-account-update.js";

const testDatabasePassword = randomBytes(24).toString("base64url");
const environment = {
  nodeEnv: "development",
  databaseUrl: `postgresql://newtonite:${testDatabasePassword}@localhost:5432/newtonite`,
  postgresUser: "newtonite",
  postgresPassword: testDatabasePassword,
  postgresDatabase: "newtonite",
};

const databaseIdentity: LocalDatabaseIdentity = {
  databaseName: "newtonite",
  databaseUser: "newtonite",
  serverAddress: "172.18.0.2",
  serverPort: 5432,
};

type Fixture = {
  users: DemoAccountIdentity[];
  updates: Array<{
    id: string;
    email: string;
    name: string;
    passwordHash?: string;
  }>;
  relationships: {
    memberships: Array<{ userId: string; teamId: string; teamSlug: string; role: string }>;
    workItems: Array<{ id: string; creatorId: string; assigneeId: string | null }>;
    comments: Array<{ id: string; authorId: string }>;
    activityEvents: Array<{ id: string; actorId: string }>;
    sessions: Array<{ id: string; userId: string }>;
    idempotencyRecords: Array<{ id: string; userId: string }>;
  };
  failUpdateFor?: string;
};

function fixture(): Fixture {
  return {
    users: demoAccountMappings.map((account, index) => ({
      id: `user-${index + 1}`,
      email: account.currentEmail,
    })),
    updates: [],
    relationships: {
      memberships: demoAccountMappings.flatMap((_, index) => {
        const operationsMembership = {
          userId: `user-${index + 1}`,
          teamId: "operations-team",
          teamSlug: "operations",
          role: ["VIEWER", "MEMBER", "LEAD", "ADMIN"][index]!,
        };
        return index === 0
          ? [
              operationsMembership,
              {
                userId: "user-1",
                teamId: "customer-support-team",
                teamSlug: "customer-support",
                role: "MEMBER",
              },
            ]
          : [operationsMembership];
      }),
      workItems: [{ id: "item-1", creatorId: "user-1", assigneeId: "user-2" }],
      comments: [{ id: "comment-1", authorId: "user-2" }],
      activityEvents: [{ id: "activity-1", actorId: "user-3" }],
      sessions: [{ id: "session-1", userId: "user-4" }],
      idempotencyRecords: [{ id: "idempotency-1", userId: "user-4" }],
    },
  };
}

function createStore(state: Fixture): DemoAccountStore {
  return {
    async findUsersByEmail(emails) {
      return state.users.filter((user) => emails.includes(user.email));
    },
    async findOperationsMemberships(userIds) {
      const ids = new Set(userIds);
      return state.relationships.memberships
        .filter((membership) => ids.has(membership.userId))
        .map(({ userId, teamSlug, role }) => ({ userId, teamSlug, role }));
    },
    async updateUser(id, data) {
      if (state.failUpdateFor === id) {
        throw new Error("simulated update failure");
      }
      const user = state.users.find((candidate) => candidate.id === id);
      if (!user) {
        throw new Error("missing test user");
      }
      const occupied = state.users.find(
        (candidate) => candidate.email === data.email && candidate.id !== id,
      );
      if (occupied) {
        throw new Error("duplicate test email");
      }
      state.updates.push({ id, ...data });
      user.email = data.email;
      return { id: user.id, email: user.email };
    },
    async snapshotRelationships(userIds) {
      const included = new Set(userIds);
      const snapshot = {
        memberships: state.relationships.memberships.filter((row) => included.has(row.userId)),
        workItems: state.relationships.workItems.filter(
          (row) => included.has(row.creatorId) || (row.assigneeId && included.has(row.assigneeId)),
        ),
        comments: state.relationships.comments.filter((row) => included.has(row.authorId)),
        activityEvents: state.relationships.activityEvents.filter((row) => included.has(row.actorId)),
        sessions: state.relationships.sessions.filter((row) => included.has(row.userId)),
        idempotencyRecords: state.relationships.idempotencyRecords.filter(
          (row) => included.has(row.userId),
        ),
      };
      return JSON.stringify(snapshot);
    },
  };
}

function createTransactionalFixture(initialState: Fixture) {
  const committed = structuredClone(initialState);
  return {
    committed,
    async transaction(operation: (store: DemoAccountStore) => Promise<void>) {
      const working = structuredClone(committed);
      await operation(createStore(working));
      Object.assign(committed, working);
    },
  };
}

function passwordHashes(): Map<string, string> {
  return new Map(
    demoAccountMappings.map((account) => [account.currentEmail, `argon-hash-${account.role}`]),
  );
}

describe("demo-account update safety", () => {
  it("uses the explicitly confirmed demo-account mapping", () => {
    expect(demoAccountMappings).toEqual([
      {
        role: "VIEWER",
        currentEmail: "viewer@newtonite.local",
        name: "Pankaj Viewer",
        targetEmail: "viewer@gmail.com",
      },
      {
        role: "MEMBER",
        currentEmail: "member@newtonite.local",
        name: "Jitendra Member",
        targetEmail: "jitendra@gmail.com",
      },
      {
        role: "LEAD",
        currentEmail: "lead@newtonite.local",
        name: "Suraj Lead",
        targetEmail: "demo@gmail.com",
      },
      {
        role: "ADMIN",
        currentEmail: "admin@newtonite.local",
        name: "Umesh Admin",
        targetEmail: "umesh@gmail.com",
      },
    ]);
  });

  it("refuses non-development environments and mismatched or remote database settings", () => {
    expect(() => assertDemoAccountEnvironment({ ...environment, nodeEnv: "production" }))
      .toThrow(DemoAccountSafetyError);
    expect(() =>
      assertDemoAccountEnvironment({
        ...environment,
        databaseUrl: environment.databaseUrl.replace("@localhost", "@example.com"),
      }),
    ).toThrow(DemoAccountSafetyError);
    expect(() =>
      assertDemoAccountEnvironment({
        ...environment,
        databaseUrl: environment.databaseUrl.replace("newtonite:", "different:"),
      }),
    ).toThrow(DemoAccountSafetyError);
    expect(() =>
      assertDemoAccountEnvironment({
        ...environment,
        nodeEnv: "test",
        postgresDatabase: "newtonite",
      }),
    ).toThrow(DemoAccountSafetyError);
  });

  it("requires the live database identity to match the local Compose database", () => {
    const target = assertDemoAccountEnvironment(environment);
    expect(() =>
      assertDemoDatabaseIdentity(
        target,
        { ...databaseIdentity, databaseName: "other" },
        ["172.18.0.2"],
      ),
    ).toThrow(DemoAccountSafetyError);
    expect(() =>
      assertDemoDatabaseIdentity(target, databaseIdentity, ["172.18.0.3"]),
    ).toThrow(DemoAccountSafetyError);
    expect(() =>
      assertDemoDatabaseIdentity(target, databaseIdentity, ["172.18.0.2"]),
    ).not.toThrow();
  });

  it("matches PostgreSQL IPv4 host-prefix notation to the inspected Docker IP", () => {
    const target = assertDemoAccountEnvironment(environment);
    expect(() =>
      assertDemoDatabaseIdentity(
        target,
        { ...databaseIdentity, serverAddress: "172.18.0.2/32" },
        ["172.18.0.2"],
      ),
    ).not.toThrow();
  });

  it("rejects a different IP and malformed address formats", () => {
    const target = assertDemoAccountEnvironment(environment);
    expect(() =>
      assertDemoDatabaseIdentity(
        target,
        { ...databaseIdentity, serverAddress: "172.18.0.3/32" },
        ["172.18.0.2"],
      ),
    ).toThrow(DemoAccountSafetyError);
    expect(() =>
      assertDemoDatabaseIdentity(
        target,
        { ...databaseIdentity, serverAddress: "172.18.0.2/24" },
        ["172.18.0.2"],
      ),
    ).toThrow(DemoAccountSafetyError);
    expect(() =>
      assertDemoDatabaseIdentity(
        target,
        { ...databaseIdentity, serverAddress: "not-an-ip" },
        ["172.18.0.2"],
      ),
    ).toThrow(DemoAccountSafetyError);
    expect(() =>
      assertDemoDatabaseIdentity(target, databaseIdentity, ["172.18.0.2/24"]),
    ).toThrow(DemoAccountSafetyError);
  });

  it("preserves strict IPv6 matching while accepting PostgreSQL host-prefix notation", () => {
    const target = assertDemoAccountEnvironment(environment);
    const ipv6Identity = { ...databaseIdentity, serverAddress: "2001:db8::1/128" };
    expect(() =>
      assertDemoDatabaseIdentity(target, ipv6Identity, ["2001:db8::1"]),
    ).not.toThrow();
    expect(() =>
      assertDemoDatabaseIdentity(target, ipv6Identity, ["2001:db8::2"]),
    ).toThrow(DemoAccountSafetyError);
  });

  it("fails preview when any source account is missing", async () => {
    const state = fixture();
    state.users.pop();
    await expect(previewDemoAccountUpdates(createStore(state))).rejects.toThrow(
      /Required source account/,
    );
  });

  it("rejects ambiguous source identities that resolve to multiple user IDs", async () => {
    const state = fixture();
    state.users.push({
      id: "duplicate-viewer-id",
      email: demoAccountMappings[0].currentEmail,
    });
    await expect(previewDemoAccountUpdates(createStore(state))).rejects.toThrow(
      /resolved to multiple user IDs/,
    );
  });

  it("rejects duplicate target email mappings", async () => {
    const state = fixture();
    const duplicated = demoAccountMappings.map((account, index) =>
      index === 1 ? { ...account, targetEmail: demoAccountMappings[0].targetEmail } : account,
    );
    await expect(
      previewDemoAccountUpdates(createStore(state), duplicated),
    ).rejects.toThrow(/target email addresses must be unique/);
  });

  it("refuses to repurpose a conflicting target account and reports only its ID", async () => {
    const state = fixture();
    state.users.push({ id: "unrelated-user-id", email: "jitendra@gmail.com" });
    await expect(previewDemoAccountUpdates(createStore(state))).rejects.toThrow(
      /jitendra@gmail\.com.*unrelated-user-id/,
    );
    expect(state.users.find((user) => user.id === "unrelated-user-id")?.email)
      .toBe("jitendra@gmail.com");
  });

  it("leaves the separate Pankaj Member account untouched", async () => {
    const initial = fixture();
    initial.users.push({ id: "pankaj-member-id", email: "member@gmail.com" });
    initial.relationships.memberships.push({
      userId: "pankaj-member-id",
      teamId: "operations-team",
      teamSlug: "operations",
      role: "MEMBER",
    });
    const { committed, transaction } = createTransactionalFixture(initial);

    await transaction((store) => applyDemoAccountUpdates(store, passwordHashes()));

    expect(committed.users.find((user) => user.id === "pankaj-member-id"))
      .toEqual({ id: "pankaj-member-id", email: "member@gmail.com" });
    expect(committed.relationships.memberships.find(
      (membership) => membership.userId === "pankaj-member-id",
    )).toEqual({
      userId: "pankaj-member-id",
      teamId: "operations-team",
      teamSlug: "operations",
      role: "MEMBER",
    });
    expect(committed.updates.some((update) => update.id === "pankaj-member-id")).toBe(false);
  });

  it("rolls back every update when any account update fails", async () => {
    const initial = fixture();
    initial.failUpdateFor = "user-3";
    const { committed, transaction } = createTransactionalFixture(initial);
    const original = structuredClone(committed);
    await expect(
      transaction((store) => applyDemoAccountUpdates(store, passwordHashes())),
    ).rejects.toThrow("simulated update failure");
    expect(committed).toEqual(original);
  });

  it("preserves all existing IDs, memberships, roles, work items, comments, activity, and sessions", async () => {
    const initial = fixture();
    const { committed, transaction } = createTransactionalFixture(initial);
    const originalIds = committed.users.map((user) => user.id);
    const originalRelationships = structuredClone(committed.relationships);

    await transaction((store) => applyDemoAccountUpdates(store, passwordHashes()));

    expect(committed.users.map((user) => user.id)).toEqual(originalIds);
    expect(committed.users.map((user) => user.email)).toEqual(
      demoAccountMappings.map((account) => account.targetEmail),
    );
    expect(committed.updates).toEqual(
      demoAccountMappings.map((account, index) => ({
        id: `user-${index + 1}`,
        email: account.targetEmail,
        name: account.name,
        passwordHash: `argon-hash-${account.role}`,
      })),
    );
    expect(committed.relationships).toEqual(originalRelationships);
  });

  it("allows guarded seed-style identity updates without changing password hashes", async () => {
    const initial = fixture();
    const { committed, transaction } = createTransactionalFixture(initial);

    await transaction((store) => applyDemoAccountUpdates(store));

    expect(committed.updates).toEqual(
      demoAccountMappings.map((account, index) => ({
        id: `user-${index + 1}`,
        email: account.targetEmail,
        name: account.name,
      })),
    );
    expect(committed.relationships).toEqual(initial.relationships);
  });
});
