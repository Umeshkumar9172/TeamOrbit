import dotenv from "dotenv";
import { resolve } from "node:path";
import { defineConfig } from "prisma/config";

dotenv.config({ path: resolve(process.cwd(), "../.env") });

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: "../database/prisma/schema.prisma",
  migrations: {
    path: "../database/prisma/migrations",
    seed: "tsx ../database/seed.ts",
  },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
