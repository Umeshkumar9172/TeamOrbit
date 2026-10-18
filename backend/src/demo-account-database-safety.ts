import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { getPrisma } from "./database.js";

export class DemoAccountSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoAccountSafetyError";
  }
}

export type LocalDatabaseIdentity = {
  databaseName: string;
  databaseUser: string;
  serverAddress: string | null;
  serverPort: number | null;
};

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const composeFile = resolve(projectRoot, "docker-compose.yml");

type ComposeService = {
  ID?: string;
  Service?: string;
  State?: string;
  Publishers?: Array<{
    URL?: string;
    TargetPort?: number;
    PublishedPort?: number;
    Protocol?: string;
  }>;
};

export type DemoAccountEnvironmentInput = {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  postgresUser: string | undefined;
  postgresPassword: string | undefined;
  postgresDatabase: string | undefined;
};

export type DemoAccountDatabaseTarget = {
  databaseName: string;
  databaseUser: string;
  databasePort: number;
  host: string;
};

export type DemoAccountIdentityClient = Pick<
  ReturnType<typeof getPrisma>,
  "$queryRaw"
>;

export function assertDemoAccountEnvironment(
  input: DemoAccountEnvironmentInput,
): DemoAccountDatabaseTarget {
  if (input.nodeEnv !== "development" && input.nodeEnv !== "test") {
    throw new DemoAccountSafetyError(
      "Demo-account operations require NODE_ENV=development or NODE_ENV=test.",
    );
  }

  if (
    !input.databaseUrl ||
    !input.postgresUser ||
    !input.postgresPassword ||
    !input.postgresDatabase
  ) {
    throw new DemoAccountSafetyError(
      "Database target settings are incomplete; refusing to connect.",
    );
  }

  let url: URL;
  try {
    url = new URL(input.databaseUrl);
  } catch {
    throw new DemoAccountSafetyError("The configured database URL is invalid.");
  }

  const host = url.hostname.toLowerCase();
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !["localhost", "127.0.0.1", "::1"].includes(host)
  ) {
    throw new DemoAccountSafetyError(
      "The database URL must use a local PostgreSQL loopback address.",
    );
  }

  const databasePort = url.port ? Number(url.port) : 5432;
  try {
    if (
      databasePort !== 5432 ||
      decodeURIComponent(url.username) !== input.postgresUser ||
      decodeURIComponent(url.password) !== input.postgresPassword ||
      decodeURIComponent(url.pathname.slice(1)) !== input.postgresDatabase
    ) {
      throw new DemoAccountSafetyError(
        "The database URL does not match the configured local PostgreSQL identity.",
      );
    }
  } catch (error) {
    if (error instanceof DemoAccountSafetyError) {
      throw error;
    }
    throw new DemoAccountSafetyError(
      "The database URL contains malformed encoded configuration.",
    );
  }

  if (
    input.nodeEnv === "test" &&
    !/(?:_test|-test)$/i.test(input.postgresDatabase)
  ) {
    throw new DemoAccountSafetyError(
      "NODE_ENV=test requires a database name ending in _test or -test.",
    );
  }

  return {
    databaseName: input.postgresDatabase,
    databaseUser: input.postgresUser,
    databasePort,
    host,
  };
}

export function assertDemoDatabaseIdentity(
  target: DemoAccountDatabaseTarget,
  identity: LocalDatabaseIdentity,
  composeAddresses: readonly string[],
): void {
  const serverAddress = normalizeHostAddress(identity.serverAddress);
  const normalizedComposeAddresses = composeAddresses.map(normalizeHostAddress);

  if (
    identity.databaseName !== target.databaseName ||
    identity.databaseUser !== target.databaseUser ||
    identity.serverPort !== target.databasePort ||
    !normalizedComposeAddresses.includes(serverAddress)
  ) {
    throw new DemoAccountSafetyError(
      "The connected database identity does not match the local Compose development database.",
    );
  }
}

function normalizeHostAddress(address: string | null): string {
  if (!address) {
    throw new DemoAccountSafetyError(
      "The database server address is missing or malformed.",
    );
  }

  const parts = address.split("/");
  if (parts.length > 2) {
    throw new DemoAccountSafetyError(
      "The database server address is missing or malformed.",
    );
  }

  const host = parts[0]!;
  const version = isIP(host);
  if (version === 0) {
    throw new DemoAccountSafetyError(
      "The database server address is missing or malformed.",
    );
  }

  if (parts.length === 2) {
    const prefix = parts[1]!;
    const hostPrefix = version === 4 ? 32 : 128;
    if (!/^\d+$/.test(prefix) || Number(prefix) !== hostPrefix) {
      throw new DemoAccountSafetyError(
        "The database server address has an unsupported network prefix.",
      );
    }
  }

  return host;
}

function parseComposeServices(output: string): ComposeService[] {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed as ComposeService[];
    }
    if (typeof parsed === "object" && parsed !== null) {
      return [parsed as ComposeService];
    }
  } catch {
    return trimmed.split(/\r?\n/).map((line) => JSON.parse(line) as ComposeService);
  }

  return [];
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

export async function inspectComposeDatabaseAddresses(): Promise<string[]> {
  let services: ComposeService[];
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", "-f", composeFile, "ps", "--format", "json", "db"],
      { cwd: projectRoot, windowsHide: true },
    );
    services = parseComposeServices(stdout);
  } catch {
    throw new DemoAccountSafetyError(
      "Could not verify the local Docker Compose database service.",
    );
  }

  const databaseService = services.find(
    (service) => service.Service === "db" && service.State?.toLowerCase() === "running",
  );
  if (!databaseService?.ID || !/^[0-9a-f]{12,64}$/i.test(databaseService.ID)) {
    throw new DemoAccountSafetyError(
      "The configured local Docker Compose database is not verifiably running.",
    );
  }

  const publishesLocalPostgres = databaseService.Publishers?.some((publisher) => {
    const host = publisher.URL ?? "";
    const localBinding =
      !host || host === "0.0.0.0" || host === "::" || isLoopbackAddress(host);
    return (
      localBinding &&
      publisher.TargetPort === 5432 &&
      publisher.PublishedPort === 5432 &&
      (publisher.Protocol === undefined || publisher.Protocol === "tcp")
    );
  });
  if (!publishesLocalPostgres) {
    throw new DemoAccountSafetyError(
      "The Compose database does not publish the expected local PostgreSQL port.",
    );
  }

  let networks: Record<string, { IPAddress?: string }>;
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "--format", "{{json .NetworkSettings.Networks}}", databaseService.ID],
      { cwd: projectRoot, windowsHide: true },
    );
    networks = JSON.parse(stdout.trim()) as Record<string, { IPAddress?: string }>;
  } catch {
    throw new DemoAccountSafetyError(
      "Could not verify the local Compose database network identity.",
    );
  }

  const addresses = Object.values(networks)
    .map((network) => network.IPAddress)
    .filter((address): address is string => Boolean(address));
  if (addresses.length === 0) {
    throw new DemoAccountSafetyError(
      "The local Compose database has no verifiable network address.",
    );
  }
  return addresses;
}

export async function verifyDemoDatabaseIdentity(
  client: DemoAccountIdentityClient,
  target: DemoAccountDatabaseTarget,
  composeAddresses: readonly string[],
): Promise<void> {
  const rows = await client.$queryRaw<LocalDatabaseIdentity[]>`
    SELECT
      current_database() AS "databaseName",
      current_user AS "databaseUser",
      inet_server_addr()::text AS "serverAddress",
      inet_server_port() AS "serverPort"
  `;
  const identity = rows[0];
  if (!identity) {
    throw new DemoAccountSafetyError("The database did not return an identity.");
  }
  assertDemoDatabaseIdentity(target, identity, composeAddresses);
}
