import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertDemoAccountEnvironment,
  assertDemoDatabaseIdentity,
  DemoAccountSafetyError,
  type LocalDatabaseIdentity,
} from "./demo-account-database-safety.js";
import { confirmDemoAccountSeed } from "./demo-account-seed.js";

const testDatabasePassword = randomBytes(24).toString("base64url");
const environment = {
  nodeEnv: "development",
  databaseUrl: `postgresql://newtonite:${testDatabasePassword}@localhost:5432/newtonite`,
  postgresUser: "newtonite",
  postgresPassword: testDatabasePassword,
  postgresDatabase: "newtonite",
};

const identity: LocalDatabaseIdentity = {
  databaseName: "newtonite",
  databaseUser: "newtonite",
  serverAddress: "172.18.0.2",
  serverPort: 5432,
};

describe("development demo-account seed safety", () => {
  it("rejects environments and database targets outside the allowed local configuration", () => {
    expect(() =>
      assertDemoAccountEnvironment({ ...environment, nodeEnv: "production" }),
    ).toThrow(DemoAccountSafetyError);
    expect(() =>
      assertDemoAccountEnvironment({
        ...environment,
        databaseUrl: environment.databaseUrl.replace("@localhost", "@example.com"),
      }),
    ).toThrow(DemoAccountSafetyError);
  });

  it("rejects a connected identity that does not match the inspected Compose database", () => {
    const target = assertDemoAccountEnvironment(environment);
    expect(() =>
      assertDemoDatabaseIdentity(target, identity, ["172.18.0.3"]),
    ).toThrow(DemoAccountSafetyError);
  });

  it("does not continue when explicit confirmation is declined", async () => {
    const ask = vi.fn().mockResolvedValue("no");
    await expect(confirmDemoAccountSeed(true, ask)).resolves.toBe(false);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("aborts non-interactive execution before requesting confirmation", async () => {
    const ask = vi.fn();
    await expect(confirmDemoAccountSeed(false, ask)).rejects.toThrow(
      /interactive terminal/,
    );
    expect(ask).not.toHaveBeenCalled();
  });
});
