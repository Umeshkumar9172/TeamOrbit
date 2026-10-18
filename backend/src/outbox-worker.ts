import { getPrisma, disconnectPrisma } from "./database.js";
import { Prisma } from "./generated/prisma/client.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type ClaimedJob = {
  id: string;
  eventType: string;
  payload: Prisma.JsonValue;
  attempts: number;
  lockedAt: Date;
};

export type OutboxWorkerOptions = {
  batchSize?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maximumDelayMs?: number;
  lockTimeoutMs?: number;
  handler?: (job: ClaimedJob) => Promise<void>;
};

const defaultOptions = {
  batchSize: 10,
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maximumDelayMs: 5 * 60 * 1000,
  lockTimeoutMs: 5 * 60 * 1000,
};

export async function runOutboxOnce(options: OutboxWorkerOptions = {}): Promise<number> {
  const configuration = { ...defaultOptions, ...options };
  validateOptions(configuration);
  const jobs = await claimJobs(configuration);
  for (const job of jobs) {
    try {
      await getPrisma().$transaction(async (tx) => {
        const lock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "OutboxJob"
          WHERE "id" = ${job.id}::uuid
            AND "status" = 'PROCESSING'
            AND "lockedAt" = ${job.lockedAt}
          FOR UPDATE SKIP LOCKED
        `;
        if (lock.length === 0) return;
        if (options.handler) {
          await options.handler(job);
        } else {
          await handleActivityEvent(tx, job);
        }
        await tx.outboxJob.updateMany({
          where: {
            id: job.id,
            status: "PROCESSING",
            lockedAt: job.lockedAt,
          },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            lockedAt: null,
            lastError: null,
          },
        });
      });
    } catch (error: unknown) {
      const terminal = job.attempts >= configuration.maxAttempts;
      const delay = Math.min(
        configuration.baseDelayMs * 2 ** Math.max(0, job.attempts - 1),
        configuration.maximumDelayMs,
      );
      const errorName =
        error instanceof Error
          ? error.name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "Error"
          : "UnknownError";
      await getPrisma().outboxJob.updateMany({
        where: {
          id: job.id,
          status: "PROCESSING",
          lockedAt: job.lockedAt,
        },
        data: {
          status: terminal ? "FAILED" : "PENDING",
          nextAttemptAt: new Date(Date.now() + delay),
          lockedAt: null,
          lastError: `handler_failed:${errorName}`,
        },
      });
    }
  }
  return jobs.length;
}

async function claimJobs(
  options: typeof defaultOptions,
): Promise<ClaimedJob[]> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - options.lockTimeoutMs);
  return getPrisma().$transaction(async (tx) => {
    await tx.outboxJob.updateMany({
      where: {
        status: "PROCESSING",
        lockedAt: { lte: staleBefore },
        attempts: { gte: options.maxAttempts },
      },
      data: {
        status: "FAILED",
        lockedAt: null,
        lastError: "maximum_attempts_exceeded",
      },
    });
    return tx.$queryRaw<ClaimedJob[]>`
      WITH candidates AS (
        SELECT "id"
        FROM "OutboxJob"
        WHERE "attempts" < ${options.maxAttempts}
          AND (
            ("status" = 'PENDING' AND "nextAttemptAt" <= ${now})
            OR ("status" = 'PROCESSING' AND "lockedAt" <= ${staleBefore})
          )
        ORDER BY "nextAttemptAt" ASC, "createdAt" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${options.batchSize}
      )
      UPDATE "OutboxJob" AS job
      SET "status" = 'PROCESSING',
          "attempts" = job."attempts" + 1,
          "lockedAt" = ${now},
          "lastError" = NULL
      FROM candidates
      WHERE job."id" = candidates."id"
      RETURNING job."id", job."eventType", job."payload", job."attempts", job."lockedAt"
    `;
  });
}

async function handleActivityEvent(
  tx: Prisma.TransactionClient,
  job: ClaimedJob,
): Promise<void> {
  if (typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload)) {
    throw new Error("Invalid activity event payload.");
  }
  const payload = job.payload as Record<string, Prisma.JsonValue>;
  if (typeof payload.activityEventId !== "string") {
    throw new Error("Activity event reference is missing.");
  }
  const event = await tx.activityEvent.findUnique({
    where: { id: payload.activityEventId },
    select: { eventType: true },
  });
  if (!event || event.eventType !== job.eventType) {
    throw new Error("Activity event reference is invalid.");
  }
}

function validateOptions(
  options: typeof defaultOptions,
): void {
  if (
    !Number.isInteger(options.batchSize) ||
    options.batchSize < 1 ||
    !Number.isInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    !Number.isFinite(options.baseDelayMs) ||
    options.baseDelayMs < 0 ||
    !Number.isFinite(options.maximumDelayMs) ||
    options.maximumDelayMs < options.baseDelayMs ||
    !Number.isFinite(options.lockTimeoutMs) ||
    options.lockTimeoutMs < 1
  ) {
    throw new Error("Invalid outbox worker configuration.");
  }
}

async function start(): Promise<void> {
  const pollIntervalMs = readPositiveInteger("OUTBOX_POLL_INTERVAL_MS", 1_000);
  const maxAttempts = readPositiveInteger("OUTBOX_MAX_ATTEMPTS", 8);
  const baseDelayMs = readPositiveInteger("OUTBOX_BASE_DELAY_MS", 1_000);
  const maximumDelayMs = readPositiveInteger("OUTBOX_MAX_DELAY_MS", 300_000);
  const lockTimeoutMs = readPositiveInteger("OUTBOX_LOCK_TIMEOUT_MS", 300_000);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log("Newtonite outbox worker started.");
  try {
    while (!stopping) {
      try {
        const processed = await runOutboxOnce({
          maxAttempts,
          baseDelayMs,
          maximumDelayMs,
          lockTimeoutMs,
        });
        if (processed === 0) await sleep(pollIntervalMs);
      } catch {
        console.error("Outbox polling failed; retrying after the poll interval.");
        await sleep(pollIntervalMs);
      }
    }
  } finally {
    await disconnectPrisma();
    console.log("Newtonite outbox worker stopped.");
  }
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void start().catch((error: unknown) => {
    console.error("Outbox worker terminated unexpectedly.");
    console.error(error instanceof Error ? error.name : "UnknownError");
    process.exitCode = 1;
  });
}
