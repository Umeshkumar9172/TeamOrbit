import { Prisma } from "../backend/src/generated/prisma/client.js";
import { createDemoAccountPrismaStore } from "../backend/src/demo-account-prisma-store.js";
import { disconnectPrisma, getPrisma } from "../backend/src/database.js";
import {
  assertDemoAccountEnvironment,
  DemoAccountSafetyError,
  inspectComposeDatabaseAddresses,
  verifyDemoDatabaseIdentity,
} from "../backend/src/demo-account-database-safety.js";
import {
  applyDemoAccountUpdates,
  previewDemoAccountUpdates,
} from "../backend/src/demo-account-update.js";
import { confirmDemoAccountSeed } from "../backend/src/demo-account-seed.js";
import { createInterface } from "node:readline/promises";

async function main() {
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
    await verifyDemoDatabaseIdentity(prisma, target, composeAddresses);
    await previewDemoAccountUpdates(createDemoAccountPrismaStore(prisma));

    const confirmed = await confirmDemoAccountSeed(
      process.stdin.isTTY === true,
      async (question) => {
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await terminal.question(question);
        } finally {
          terminal.close();
        }
      },
    );
    if (!confirmed) {
      console.log("Confirmation did not match; no data was changed.");
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        await verifyDemoDatabaseIdentity(tx, target, composeAddresses);
        await applyDemoAccountUpdates(createDemoAccountPrismaStore(tx));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    console.log(
      "Existing development demo accounts updated; memberships and related data preserved. Existing sessions remain valid.",
    );
  } finally {
    await disconnectPrisma();
  }
}

main()
  .catch((error: unknown) => {
    if (error instanceof DemoAccountSafetyError) {
      console.error(error.message);
    } else {
      console.error("Development seed failed; no credentials or account details were printed.");
    }
    process.exitCode = 1;
  })
