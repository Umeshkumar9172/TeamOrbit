import { DemoAccountSafetyError } from "./demo-account-database-safety.js";

export {
  assertDemoAccountEnvironment,
  assertDemoDatabaseIdentity,
  DemoAccountSafetyError,
} from "./demo-account-database-safety.js";
export type {
  DemoAccountDatabaseTarget,
  DemoAccountEnvironmentInput,
  LocalDatabaseIdentity,
} from "./demo-account-database-safety.js";

export const demoAccountMappings = [
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
] as const;

export type DemoAccountMapping = {
  role: "VIEWER" | "MEMBER" | "LEAD" | "ADMIN";
  currentEmail: string;
  name: string;
  targetEmail: string;
};

export type DemoAccountIdentity = {
  id: string;
  email: string;
};

export type DemoAccountStore = {
  findUsersByEmail(emails: readonly string[]): Promise<DemoAccountIdentity[]>;
  findOperationsMemberships(
    userIds: readonly string[],
  ): Promise<Array<{ userId: string; teamSlug: string; role: string }>>;
  updateUser(
    id: string,
    data: { email: string; name: string; passwordHash?: string },
  ): Promise<DemoAccountIdentity>;
  snapshotRelationships(userIds: readonly string[]): Promise<string>;
};

function validateMappings(
  mappings: readonly DemoAccountMapping[],
): void {
  const sourceEmails = new Set(mappings.map((account) => account.currentEmail));
  const targetEmails = mappings.map((account) => account.targetEmail);
  if (sourceEmails.size !== mappings.length) {
    throw new DemoAccountSafetyError("The source account mapping contains duplicate emails.");
  }
  if (new Set(targetEmails).size !== targetEmails.length) {
    throw new DemoAccountSafetyError("The target email addresses must be unique.");
  }
}

async function resolveExistingAccounts(
  store: Pick<DemoAccountStore, "findUsersByEmail" | "findOperationsMemberships">,
  mappings: readonly DemoAccountMapping[],
): Promise<Map<string, DemoAccountIdentity>> {
  validateMappings(mappings);
  const emails = [...new Set(mappings.flatMap(({ currentEmail, targetEmail }) => [
    currentEmail,
    targetEmail,
  ]))];
  const users = await store.findUsersByEmail(emails);
  const byEmail = new Map(users.map((user) => [user.email, user]));
  if (byEmail.size !== users.length) {
    throw new DemoAccountSafetyError(
      "An account email resolved to multiple user IDs; no accounts were changed.",
    );
  }

  const sourceAccounts = new Map<string, DemoAccountIdentity>();
  for (const account of mappings) {
    const source = byEmail.get(account.currentEmail);
    if (!source) {
      throw new DemoAccountSafetyError(
        `Required source account ${account.currentEmail} is missing; no accounts were changed.`,
      );
    }
    sourceAccounts.set(account.currentEmail, source);
  }

  const memberships = await store.findOperationsMemberships(
    [...sourceAccounts.values()].map(({ id }) => id),
  );
  for (const account of mappings) {
    const source = sourceAccounts.get(account.currentEmail)!;
    const membership = memberships.find(
      (candidate) => candidate.userId === source.id && candidate.teamSlug === "operations",
    );
    if (membership?.role !== account.role) {
      throw new DemoAccountSafetyError(
        `The ${account.role} source account does not have its expected Operations membership; no accounts were changed.`,
      );
    }
  }

  for (const account of mappings) {
    const conflict = byEmail.get(account.targetEmail);
    const source = sourceAccounts.get(account.currentEmail);
    if (conflict && conflict.id !== source?.id) {
      throw new DemoAccountSafetyError(
        `Target email ${account.targetEmail} belongs to another account (user ID ${conflict.id}); no accounts were changed.`,
      );
    }
  }
  return sourceAccounts;
}

export async function previewDemoAccountUpdates(
  store: Pick<DemoAccountStore, "findUsersByEmail" | "findOperationsMemberships">,
  mappings: readonly DemoAccountMapping[] = demoAccountMappings,
) {
  const sourceAccounts = await resolveExistingAccounts(store, mappings);
  return mappings.map((account) => ({
    ...account,
    id: sourceAccounts.get(account.currentEmail)!.id,
  }));
}

export async function applyDemoAccountUpdates(
  store: DemoAccountStore,
  passwordHashes?: ReadonlyMap<string, string>,
  mappings: readonly DemoAccountMapping[] = demoAccountMappings,
): Promise<void> {
  const sourceAccounts = await resolveExistingAccounts(store, mappings);
  if (passwordHashes) {
    for (const account of mappings) {
      if (!passwordHashes.get(account.currentEmail)) {
        throw new DemoAccountSafetyError(
          `A prepared password hash is missing for ${account.role}; no accounts were changed.`,
        );
      }
    }
  }

  const userIds = mappings.map(
    (account) => sourceAccounts.get(account.currentEmail)!.id,
  );
  const relationshipsBefore = await store.snapshotRelationships(userIds);

  for (const account of mappings) {
    const source = sourceAccounts.get(account.currentEmail)!;
    const data: { email: string; name: string; passwordHash?: string } = {
      email: account.targetEmail,
      name: account.name,
    };
    const passwordHash = passwordHashes?.get(account.currentEmail);
    if (passwordHash) {
      data.passwordHash = passwordHash;
    }
    const updated = await store.updateUser(source.id, data);
    if (updated.id !== source.id || updated.email !== account.targetEmail) {
      throw new DemoAccountSafetyError(
        `The update for ${account.role} did not preserve its user ID; the transaction must roll back.`,
      );
    }
  }

  const relationshipsAfter = await store.snapshotRelationships(userIds);
  if (relationshipsAfter !== relationshipsBefore) {
    throw new DemoAccountSafetyError(
      "Related account data changed unexpectedly; the transaction must roll back.",
    );
  }
}
