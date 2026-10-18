import { getPrisma } from "./database.js";
import type { DemoAccountStore } from "./demo-account-update.js";

type DemoAccountPrismaClient = Pick<
  ReturnType<typeof getPrisma>,
  | "user"
  | "membership"
  | "workItem"
  | "comment"
  | "activityEvent"
  | "session"
  | "idempotencyRecord"
>;

export function createDemoAccountPrismaStore(
  client: DemoAccountPrismaClient,
): DemoAccountStore {
  return {
    async findUsersByEmail(emails) {
      return client.user.findMany({
        where: { email: { in: [...emails] } },
        select: { id: true, email: true },
      });
    },
    async findOperationsMemberships(userIds) {
      const memberships = await client.membership.findMany({
        where: { userId: { in: [...userIds] } },
        select: { userId: true, role: true, team: { select: { slug: true } } },
      });
      return memberships
        .map(({ userId, role, team }) => ({
          userId,
          role,
          teamSlug: team.slug,
        }))
        .filter(({ teamSlug }) => teamSlug === "operations");
    },
    async updateUser(id, data) {
      return client.user.update({
        where: { id },
        data,
        select: { id: true, email: true },
      });
    },
    async snapshotRelationships(userIds) {
      const ids = [...userIds];
      const memberships = await client.membership.findMany({
        where: { userId: { in: ids } },
      });
      const workItems = await client.workItem.findMany({
        where: {
          OR: [{ creatorId: { in: ids } }, { assigneeId: { in: ids } }],
        },
      });
      const comments = await client.comment.findMany({
        where: { authorId: { in: ids } },
      });
      const activityEvents = await client.activityEvent.findMany({
        where: { actorId: { in: ids } },
      });
      const sessions = await client.session.findMany({
        where: { userId: { in: ids } },
      });
      const idempotencyRecords = await client.idempotencyRecord.findMany({
        where: { userId: { in: ids } },
      });

      const sortRecords = (records: unknown[]) =>
        records.sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        );
      return JSON.stringify({
        memberships: sortRecords(memberships),
        workItems: sortRecords(workItems),
        comments: sortRecords(comments),
        activityEvents: sortRecords(activityEvents),
        sessions: sortRecords(sessions),
        idempotencyRecords: sortRecords(idempotencyRecords),
      });
    },
  };
}
