export const databaseIntegrationOptIn = "RUN_DATABASE_INTEGRATION_TESTS";
export const databaseIntegrationUrl = "TEST_DATABASE_URL";

export type IntegrationTestEnvironment = Record<string, string | undefined>;

export type IntegrationTestConfiguration = {
  enabled: boolean;
  databaseUrl?: string;
};

type ConnectionTarget = {
  protocol: "postgres:";
  hostname: string;
  hostPort: string;
  port: string;
  databaseName: string;
};

function parsePostgresConnectionTarget(
  connectionString: string,
  variableName: string,
): ConnectionTarget {
  if (/[\\\s?#]/.test(connectionString)) {
    throw new Error(`${variableName} contains an unsupported URL form.`);
  }

  if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    throw new Error(`${variableName} must use an absolute PostgreSQL URL.`);
  }

  const authority = connectionString.match(/^postgres(?:ql)?:\/\/([^/]+)/i)?.[1];
  if (!authority) {
    throw new Error(`${variableName} must specify a PostgreSQL host.`);
  }
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL.`);
  }

  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    (url.port !== "" && url.port !== "5432")
  ) {
    throw new Error(
      `${variableName} must use a direct PostgreSQL URL with no query, fragment, service, socket, or endpoint override.`,
    );
  }

  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    throw new Error(`${variableName} contains malformed URL encoding.`);
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error(`${variableName} contains malformed database-name encoding.`);
  }
  if (
    !/^\/[^/]+$/.test(url.pathname) ||
    url.pathname !== `/${databaseName}` ||
    !/^[A-Za-z0-9_-]+$/.test(databaseName)
  ) {
    throw new Error(`${variableName} must specify one plain PostgreSQL database name.`);
  }

  return {
    protocol: "postgres:",
    hostname: ["localhost", "127.0.0.1", "[::1]"].includes(
      url.hostname.toLowerCase(),
    )
      ? "loopback"
      : url.hostname.toLowerCase(),
    hostPort,
    port: url.port || "5432",
    databaseName,
  };
}

export function databaseIntegrationTestsAreEnabled(
  environment: IntegrationTestEnvironment,
): boolean {
  return environment[databaseIntegrationOptIn] === "1";
}

export function getIntegrationTestConfiguration(
  environment: IntegrationTestEnvironment,
): IntegrationTestConfiguration {
  const optIn = environment[databaseIntegrationOptIn];
  if (!databaseIntegrationTestsAreEnabled(environment) && !optIn) {
    return { enabled: false };
  }
  if (optIn !== "1") {
    throw new Error(`${databaseIntegrationOptIn} must be set to exactly 1.`);
  }

  const databaseUrl = environment[databaseIntegrationUrl];
  if (!databaseUrl) {
    throw new Error(
      `${databaseIntegrationUrl} is required when database integration tests are enabled.`,
    );
  }

  const testTarget = parsePostgresConnectionTarget(databaseUrl, databaseIntegrationUrl);
  if (
    !/^(?:127\.0\.0\.1|\[::1\])(?::5432)?$/.test(testTarget.hostPort) ||
    testTarget.hostname !== "loopback" ||
    !/(?:_test|-test)$/i.test(testTarget.databaseName)
  ) {
    throw new Error(
      `${databaseIntegrationUrl} must target a local PostgreSQL database with a dedicated _test or -test name.`,
    );
  }

  const applicationUrl = environment.DATABASE_URL;
  if (applicationUrl) {
    const applicationTarget = parsePostgresConnectionTarget(
      applicationUrl,
      "DATABASE_URL",
    );
    if (
      applicationTarget.hostname === testTarget.hostname &&
      applicationTarget.port === testTarget.port &&
      applicationTarget.databaseName === testTarget.databaseName
    ) {
      throw new Error(
        `${databaseIntegrationUrl} must not point to the application database.`,
      );
    }
  }

  return { enabled: true, databaseUrl };
}

export function configureIntegrationTestDatabase(
  environment: IntegrationTestEnvironment,
): boolean {
  const configuration = getIntegrationTestConfiguration(environment);
  if (!configuration.enabled) {
    return false;
  }
  if (!configuration.databaseUrl) {
    throw new Error(`${databaseIntegrationUrl} was not validated.`);
  }
  environment.DATABASE_URL = configuration.databaseUrl;
  return true;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validFixtureIds(ids: readonly (string | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id && uuidPattern.test(id))))];
}

export type IntegrationFixtureCleanup = {
  teamIds: readonly (string | undefined)[];
  userIds: readonly (string | undefined)[];
  deleteWorkItems: (teamIds: string[]) => Promise<unknown>;
  deleteIdempotencyRecords: (userIds: string[]) => Promise<unknown>;
  deleteSessions: (userIds: string[]) => Promise<unknown>;
  deleteUsers: (userIds: string[]) => Promise<unknown>;
  deleteTeams: (teamIds: string[]) => Promise<unknown>;
};

export async function cleanupIntegrationFixtures(
  cleanup: IntegrationFixtureCleanup,
): Promise<void> {
  const teamIds = validFixtureIds(cleanup.teamIds);
  const userIds = validFixtureIds(cleanup.userIds);

  if (teamIds.length > 0) await cleanup.deleteWorkItems(teamIds);
  if (userIds.length > 0) {
    await cleanup.deleteIdempotencyRecords(userIds);
    await cleanup.deleteSessions(userIds);
    await cleanup.deleteUsers(userIds);
  }
  if (teamIds.length > 0) await cleanup.deleteTeams(teamIds);
}
