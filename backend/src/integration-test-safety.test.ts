import { describe, expect, it, vi } from "vitest";
import {
  cleanupIntegrationFixtures,
  configureIntegrationTestDatabase,
  databaseIntegrationTestsAreEnabled,
  getIntegrationTestConfiguration,
  validFixtureIds,
} from "./integration-test-safety.js";

const testUrl = "postgresql://test_user:test_password@localhost:5432/newtonite_test";
const validId = "93e2c711-95aa-4ca5-b707-6e92a45558f6";
const localTestUrl = testUrl.replace("localhost", "127.0.0.1");

describe("database integration test safety", () => {
  it("disables integration tests without touching the application database URL", () => {
    const environment = { DATABASE_URL: "postgresql://local-app-db" };
    expect(databaseIntegrationTestsAreEnabled(environment)).toBe(false);
    expect(configureIntegrationTestDatabase(environment)).toBe(false);
    expect(environment.DATABASE_URL).toBe("postgresql://local-app-db");
    expect(getIntegrationTestConfiguration(environment)).toEqual({ enabled: false });
  });

  it("requires explicit opt-in and a dedicated local test database", () => {
    expect(() =>
      getIntegrationTestConfiguration({
        RUN_DATABASE_INTEGRATION_TESTS: "1",
      }),
    ).toThrow(/TEST_DATABASE_URL is required/);
    expect(() =>
      getIntegrationTestConfiguration({
        RUN_DATABASE_INTEGRATION_TESTS: "1",
        TEST_DATABASE_URL: "postgresql://user:password@example.com:5432/newtonite_test",
      }),
    ).toThrow(/local PostgreSQL/);
    expect(() =>
      getIntegrationTestConfiguration({
        RUN_DATABASE_INTEGRATION_TESTS: "1",
        TEST_DATABASE_URL: "not-a-url",
      }),
    ).toThrow(/absolute PostgreSQL URL/);
    expect(() =>
      getIntegrationTestConfiguration({
        RUN_DATABASE_INTEGRATION_TESTS: "1",
        TEST_DATABASE_URL:
          "postgresql://user:password@localhost:5432/newtonite_test?host=remote.example",
      }),
    ).toThrow(/unsupported URL form/);
    expect(() =>
      getIntegrationTestConfiguration({
        RUN_DATABASE_INTEGRATION_TESTS: "1",
        TEST_DATABASE_URL:
          "postgresql://user:password@localhost:5432/newtonite_test?port=6543",
      }),
    ).toThrow(/unsupported URL form/);
    expect(() =>
      getIntegrationTestConfiguration({
        RUN_DATABASE_INTEGRATION_TESTS: "1",
        TEST_DATABASE_URL:
          "postgresql://user:password@localhost:5432/newtonite_test?hostaddr=203.0.113.20",
      }),
    ).toThrow(/unsupported URL form/);
    expect(() =>
      getIntegrationTestConfiguration({
        RUN_DATABASE_INTEGRATION_TESTS: "1",
        TEST_DATABASE_URL:
          "postgresql://user:password@localhost:5432/newtonite_test?service=prod",
      }),
    ).toThrow(/unsupported URL form/);
    for (const ambiguousUrl of [
      "postgresql://user:password@localhost:5432/newtonite_test#fragment",
      "postgresql://user:password@localhost:5432/newtonite_test?",
      "postgresql://user:password@localhost:5432/newtonite_test#",
      "postgresql://user:password@localhost:5433/newtonite_test",
      "postgresql://user:password@localhost./newtonite_test",
      "postgresql://user:password@localhost:5432/newtonite%2Fprod_test",
      "postgresql://user:password@localhost:5432/newtonite_test\\@remote.example",
    ]) {
      expect(() =>
        getIntegrationTestConfiguration({
          RUN_DATABASE_INTEGRATION_TESTS: "1",
          TEST_DATABASE_URL: ambiguousUrl,
        }),
      ).toThrow();
    }
    expect(() =>
      getIntegrationTestConfiguration({
        RUN_DATABASE_INTEGRATION_TESTS: "1",
        TEST_DATABASE_URL: "postgresql://user:password@localhost:5432/newtonite",
      }),
    ).toThrow(/dedicated/);
    expect(() =>
      getIntegrationTestConfiguration({
        RUN_DATABASE_INTEGRATION_TESTS: "1",
        TEST_DATABASE_URL: localTestUrl,
        DATABASE_URL: localTestUrl,
      }),
    ).toThrow();
  });

  it("uses only TEST_DATABASE_URL after successful validation", () => {
    const environment = {
      RUN_DATABASE_INTEGRATION_TESTS: "1",
      TEST_DATABASE_URL: localTestUrl,
      DATABASE_URL: "postgresql://app:secret@localhost:5432/newtonite",
    };
    expect(configureIntegrationTestDatabase(environment)).toBe(true);
    expect(environment.DATABASE_URL).toBe(localTestUrl);
  });

  it("rejects localhost test database targets", () => {
    expect(() =>
      getIntegrationTestConfiguration({
        RUN_DATABASE_INTEGRATION_TESTS: "1",
        TEST_DATABASE_URL: "postgres://test_user:test_password@localhost/newtonite_test",
        DATABASE_URL:
          "postgresql://app_user:app_password@127.0.0.1:5432/newtonite_test",
      }),
    ).toThrow();
  });

  it("accepts only literal IPv4 and IPv6 loopback test hosts", () => {
    const urlForHost = (host: string) =>
      ["postgresql:", "", `user:password@${host}:5432`, "newtonite_test"].join("/");

    for (const host of ["127.0.0.1", "[::1]"]) {
      expect(
        getIntegrationTestConfiguration({
          RUN_DATABASE_INTEGRATION_TESTS: "1",
          TEST_DATABASE_URL: urlForHost(host),
        }).enabled,
      ).toBe(true);
      expect(() =>
        getIntegrationTestConfiguration({
          RUN_DATABASE_INTEGRATION_TESTS: "1",
          TEST_DATABASE_URL: urlForHost(host),
          DATABASE_URL: urlForHost(host),
        }),
      ).toThrow();
    }

    for (const host of [
      "localhost",
      "db.example.com",
      "127.0.0.2",
      "127.1",
      "0177.0.0.1",
      "127.0.0.1.",
      "[::ffff:127.0.0.1]",
      "[0:0:0:0:0:0:0:1]",
      "%31%32%37.0.0.1",
    ]) {
      expect(() =>
        getIntegrationTestConfiguration({
          RUN_DATABASE_INTEGRATION_TESTS: "1",
          TEST_DATABASE_URL: urlForHost(host),
        }),
      ).toThrow();
    }
  });

  it("rejects localhost when comparing application and test targets", () => {
    expect(() =>
      getIntegrationTestConfiguration({
        RUN_DATABASE_INTEGRATION_TESTS: "1",
        TEST_DATABASE_URL: "postgres://test_user:test_password@localhost/newtonite_test",
        DATABASE_URL:
          "postgresql://app_user:app_password@127.0.0.1:5432/newtonite_test",
      }),
    ).toThrow();
  });

  it("does not clean up invalid or uncreated fixture IDs after partial setup", async () => {
    const calls = {
      workItems: vi.fn(async () => {}),
      idempotency: vi.fn(async () => {}),
      sessions: vi.fn(async () => {}),
      users: vi.fn(async () => {}),
      teams: vi.fn(async () => {}),
    };
    await cleanupIntegrationFixtures({
      teamIds: [validId, "", undefined, "not-a-uuid"],
      userIds: ["", validId, undefined],
      deleteWorkItems: calls.workItems,
      deleteIdempotencyRecords: calls.idempotency,
      deleteSessions: calls.sessions,
      deleteUsers: calls.users,
      deleteTeams: calls.teams,
    });

    expect(validFixtureIds(["", undefined, "not-a-uuid", validId])).toEqual([validId]);
    expect(calls.workItems).toHaveBeenCalledWith([validId]);
    expect(calls.idempotency).toHaveBeenCalledWith([validId]);
    expect(calls.sessions).toHaveBeenCalledWith([validId]);
    expect(calls.users).toHaveBeenCalledWith([validId]);
    expect(calls.teams).toHaveBeenCalledWith([validId]);
  });

  it("skips every cleanup query when setup created no valid fixture IDs", async () => {
    const cleanupOperation = vi.fn(async () => {});
    await cleanupIntegrationFixtures({
      teamIds: ["", undefined],
      userIds: ["invalid"],
      deleteWorkItems: cleanupOperation,
      deleteIdempotencyRecords: cleanupOperation,
      deleteSessions: cleanupOperation,
      deleteUsers: cleanupOperation,
      deleteTeams: cleanupOperation,
    });
    expect(cleanupOperation).not.toHaveBeenCalled();
  });
});
