import { createInterface } from "node:readline/promises";
import { disconnectPrisma, getPrisma } from "../backend/src/database.js";
import { createDemoAccountPrismaStore } from "../backend/src/demo-account-prisma-store.js";
import {
  assertDemoAccountEnvironment,
  inspectComposeDatabaseAddresses,
  verifyDemoDatabaseIdentity,
} from "../backend/src/demo-account-database-safety.js";
import { hashPassword, verifyPassword } from "../backend/src/password.js";
import {
  applyDemoAccountUpdates,
  demoAccountMappings,
  previewDemoAccountUpdates,
} from "../backend/src/demo-account-update.js";
import { Prisma } from "../backend/src/generated/prisma/client.js";
import {
  HiddenPasswordInputError,
  readHiddenPassword,
} from "../backend/src/hidden-terminal-password.js";

const confirmationPhrase = "UPDATE FOUR DEMO ACCOUNTS";

async function collectPasswords(): Promise<Map<string, string>> {
  const passwords = new Map<string, string>();
  try {
    for (const account of demoAccountMappings) {
      passwords.set(
        account.currentEmail,
        await readHiddenPassword(
          account.role,
          {
            isTTY: process.stdin.isTTY,
            setRawMode: process.stdin.setRawMode?.bind(process.stdin),
            setEncoding: process.stdin.setEncoding.bind(process.stdin),
            resume: process.stdin.resume.bind(process.stdin),
            pause: process.stdin.pause.bind(process.stdin),
            on: (event, listener) => {
              process.stdin.on(event, listener);
            },
            off: (event, listener) => {
              process.stdin.off(event, listener);
            },
          },
          (text) => process.stdout.write(text),
        ),
      );
    }
    return passwords;
  } catch (error) {
    passwords.clear();
    throw error;
  }
}

async function confirmApply(): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const response = await terminal.question(
      `Type "${confirmationPhrase}" to continue: `,
    );
    return response === confirmationPhrase;
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if ((command !== "preview" && command !== "apply") || process.argv.length !== 3) {
    throw new Error("Use the separate preview or apply command.");
  }

  const target = assertDemoAccountEnvironment({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    postgresUser: process.env.POSTGRES_USER,
    postgresPassword: process.env.POSTGRES_PASSWORD,
    postgresDatabase: process.env.POSTGRES_DB,
  });
  const composeAddresses = await inspectComposeDatabaseAddresses();
  const prisma = getPrisma();

  try {
    await prisma.$connect();
    const verifyTarget = async (
      client: Pick<ReturnType<typeof getPrisma>, "$queryRaw">,
    ) => {
      await verifyDemoDatabaseIdentity(client, target, composeAddresses);
    };

    await verifyTarget(prisma);
    const preview = await previewDemoAccountUpdates(createDemoAccountPrismaStore(prisma));
    console.log("Validated demo account changes (read-only):");
    for (const account of preview) {
      console.log(
        `${account.role}: ${account.currentEmail} -> ${account.name} <${account.targetEmail}> (user ID ${account.id})`,
      );
    }

    if (command === "preview") {
      console.log("Preview complete; no data was changed.");
      return;
    }
    const passwords = await collectPasswords();
    const passwordHashes = new Map<string, string>();
    try {
      if (!(await confirmApply())) {
        console.log("Confirmation did not match; no data was changed.");
        return;
      }

      for (const account of demoAccountMappings) {
        const password = passwords.get(account.currentEmail);
        if (!password) {
          throw new Error("A password was not collected.");
        }
        const passwordHash = await hashPassword(password);
        if (!(await verifyPassword(passwordHash, password))) {
          throw new Error("Password hash verification failed.");
        }
        passwordHashes.set(account.currentEmail, passwordHash);
      }

      await prisma.$transaction(
        async (tx) => {
          await verifyTarget(tx);
          await applyDemoAccountUpdates(createDemoAccountPrismaStore(tx), passwordHashes);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      console.log("All four demo accounts were updated. Existing sessions remain valid.");
    } finally {
      passwords.clear();
      passwordHashes.clear();
    }
  } finally {
    await disconnectPrisma();
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error && error.name === "DemoAccountSafetyError") {
    console.error(error.message);
  } else if (error instanceof HiddenPasswordInputError) {
    console.error(`${error.message} No accounts were changed.`);
  } else {
    console.error("Demo account operation failed; no credentials were displayed.");
  }
  process.exitCode = 1;
});
