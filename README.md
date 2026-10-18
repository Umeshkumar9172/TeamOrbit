# TeamOrbit — Operations Under Pressure

**One Workspace. Every Task. Clear Accountability.**

TeamOrbit is the product name for the Operations Under Pressure project: a React, TypeScript, Vite, Express, and PostgreSQL application with team identity, cookie-based authentication, team-scoped work-item APIs, workflow/reliability services, a PostgreSQL outbox worker, and a responsive operations dashboard integrated with the existing API.

## Repository layout

```text
backend/                 Express API, authentication, services, worker, and API tests
database/
  prisma/                Prisma schema and immutable migration history
  seed.ts                Development/test seed entry point
frontend/                React, TypeScript, Vite app, and UI interaction tests
docs/                    Engineering decisions and project documentation
docker-compose.yml       PostgreSQL, API, worker, and frontend services
package.json             npm workspaces and root development commands
```

The `@newtonite/api` and `@newtonite/web` npm workspace names are unchanged; use the root scripts below or target those workspace names directly.

## Prerequisites

- Node.js 24 or newer and npm
- Docker Desktop with Docker Compose

## Local setup

1. Install dependencies from the repository root:

   ```powershell
   npm install
   ```

2. Copy the example environment file. Set `POSTGRES_PASSWORD` to a local development password made of URL-safe characters, and make sure `DATABASE_URL` uses the same user, password, and database name. Keep `.env` private; it is ignored by Git.

   ```powershell
   Copy-Item .env.example .env
   ```

3. Start PostgreSQL:

   ```powershell
   docker compose up -d db
   ```

4. Apply the Prisma migration:

   ```powershell
   npm run db:migrate
   ```

   `npm run db:seed` is a guarded account-update operation, not a fresh-database bootstrap. It requires all four existing `@newtonite.local` source users and their expected Operations memberships. Before updating, it verifies the allowed environment, local PostgreSQL settings, the running Compose database identity, all source identities and roles, and target-email collisions; it then requires an interactive typed confirmation. It updates only the four matching user rows' email and name inside one serializable transaction; it does not create users or teams, modify memberships or password hashes, or revoke sessions. The targeted updater and seed share the same mapping and collision checks. To change passwords, use the separate interactive updater. Do not use the seed to create demo users on a blank database.

   To run the guarded seed against already-provisioned development accounts:

   ```powershell
   $env:NODE_ENV = "development"
   npm run db:seed
   Remove-Item Env:NODE_ENV
   ```

5. Start the API and frontend together:

   ```powershell
   npm run dev
   ```

6. Open <http://localhost:5173>. The API health endpoint is <http://localhost:3000/api/health>.

For a single workspace, run `npm run dev --workspace @newtonite/api` for the API or `npm run dev --workspace @newtonite/web` for the frontend. The frontend uses the Vite `/api` proxy and sends requests with browser-managed credentials; session tokens remain in the HttpOnly cookie and are not exposed to JavaScript.

The local `.env` uses `localhost` in `DATABASE_URL`, so Prisma commands and the API running on your host can connect to the Compose database. The API container uses the internal `db` hostname instead.

## Development login accounts

The targeted demo-account updater changes these existing accounts to the following details:

| Role in Operations | Display name | Email |
| --- | --- | --- |
| Viewer | Pankaj Viewer | `viewer@gmail.com` |
| Member | Jitendra Member | `jitendra@gmail.com` |
| Lead | Suraj Lead | `demo@gmail.com` |
| Admin | Umesh Admin | `umesh@gmail.com` |

Preview and apply the account update from the repository root in PowerShell. Set `NODE_ENV` only for the command and remove it afterward:

```powershell
$env:NODE_ENV = "development"
npm run db:demo-accounts:preview
npm run db:demo-accounts:update
Remove-Item Env:NODE_ENV
```

Preview is read-only. Apply requests each new password through hidden interactive terminal input and requires a typed confirmation. It refuses unless the database URL matches the configured loopback PostgreSQL settings and the live database identity matches the running local Docker Compose `db` service. It updates only the four existing user records inside one transaction; target email collisions with other accounts cause a refusal. The separate Pankaj Member account at `member@gmail.com` is not a target and is never modified or repurposed. The guarded seed uses the same verified `@newtonite.local` source accounts and target collision checks as the updater; neither the seed nor updater creates users or changes memberships. Existing login sessions remain valid after email and password changes; neither operation revokes them.

## Authentication endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Validates credentials and sets the session cookie. |
| `POST` | `/api/auth/logout` | Revokes the current session and clears the cookie. |
| `GET` | `/api/auth/me` | Returns the authenticated user and team memberships. |

Login requests require the account's email and locally chosen password. Do not store or share demo passwords in project documentation.

Sessions use cryptographically random tokens in an `HttpOnly`, `SameSite=Lax` cookie; only a SHA-256 token hash is persisted. The cookie is marked `Secure` when `NODE_ENV=production`, so production must use HTTPS. Passwords are hashed with Argon2id. The work-item routes enforce database-backed team membership and role permissions.

## Operations dashboard

The frontend restores the current cookie session, then displays the server-provided assigned-to-me, unassigned-urgent, and awaiting-my-approval queues. Work-item screens support the backend's search and status/priority/type/assignee filters, opaque cursor-based load-more pagination, item details, create and edit forms, claim/transition actions, immutable activity history, and comments. The UI does not make authorization decisions on behalf of the API; controls are role-aware for usability, and the server remains authoritative.

Item creation sends a fresh `Idempotency-Key` for each logical request. If a request has an uncertain network outcome, retrying with unchanged form values reuses its key; changing the request generates a new key. Optimistic-lock conflicts are surfaced with an explicit reload action rather than silently overwriting newer data.

## Work-item API

All work-item endpoints require the authenticated session cookie. Team access and roles are loaded from database memberships for each request; a role in one team does not grant privileges in another.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/items` | Create an item for a team the caller can write in. |
| `GET` | `/api/items` | List items in all teams the caller belongs to. |
| `GET` | `/api/items/:id` | Read an item only when the caller belongs to its team. |
| `PATCH` | `/api/items/:id` | Update permitted fields using optimistic locking. |
| `POST` | `/api/items/:id/transition` | Advance the item through the validated workflow. |
| `POST` | `/api/items/:id/claim` | Atomically claim an eligible unassigned item. |
| `GET` | `/api/items/:id/activity` | Read append-only activity for a team item. |
| `GET`, `POST` | `/api/items/:id/comments` | List or create team-scoped comments. |
| `GET` | `/api/items/dashboard` | Return assigned-to-me, unassigned urgent, and approval data. |

The team-role permission matrix is:

| Team role | Read team items | Create items | Update permitted fields | Initiate transitions* |
| --- | --- | --- | --- | --- |
| Viewer | Yes | No | No | No |
| Member | Yes | Yes | Yes | Yes |
| Lead | Yes | Yes | Yes | Yes |
| Admin | Yes | Yes | Yes | Yes |

*Except leaving `AWAITING_APPROVAL`, which requires a current `LEAD` membership in the same team. An Admin is not implicitly a Lead. The service re-reads membership for mutations. A role in another team grants no authority over the item.

Member, Lead, and Admin can update `title`, `description`, `type`, `priority`, `dueDate`, and `assigneeId`. `status`, ID, team, creator, timestamps, and `version` are server-controlled. Updates must include the version returned by the last read, for example `{ "version": 1, "priority": "HIGH" }`; a successful mutation increments the version. Missing/invalid versions are `400`. A stale version returns `409` with `code: "VERSION_CONFLICT"` and a safe `reload` URL. The API never returns the current item in a conflict response.

New items start in `OPEN`. Transitions are one step at a time:

| Current status | Allowed next status | Who may initiate |
| --- | --- | --- |
| `OPEN` | `IN_PROGRESS` | Member, Lead, or Admin of the item's team |
| `IN_PROGRESS` | `AWAITING_APPROVAL` | Member, Lead, or Admin of the item's team |
| `AWAITING_APPROVAL` | `RESOLVED` | Lead of the item's team only |
| `RESOLVED` | `CLOSED` | Member, Lead, or Admin of the item's team |
| `CLOSED` | — | Terminal; no further transition |

Use `POST /api/items/:id/transition` with `{ "version": 2, "to": "AWAITING_APPROVAL" }`. Invalid edges return `409` with `code: "INVALID_STATUS_TRANSITION"`; version races use `VERSION_CONFLICT`. No status value is accepted by ordinary `PATCH`.

`POST /api/items/:id/claim` takes `{ "version": n }`. Only an unassigned `OPEN` item is claimable, and only a Member, Lead, or Admin of the item's team may claim. The database conditionally assigns the caller and increments `version` in one transaction. Competing or stale claims return `409`; a successful claim creates its activity and outbox records in the same transaction.

Example create request:

```http
POST /api/items
Content-Type: application/json
Idempotency-Key: <unique-client-key>
Cookie: newtonite_session=<session-token>

{
  "teamId": "<team-uuid>",
  "title": "Payment processor outage",
  "description": "Payments are timing out for some customers.",
  "type": "PAYMENT",
  "priority": "URGENT",
  "assigneeId": "<same-team-user-uuid>",
  "dueDate": "2026-11-01T12:00:00.000Z"
}
```

Supported item types are `INCIDENT`, `CUSTOMER_ISSUE`, `PAYMENT`, `COMPLIANCE`, and `TASK`. Priorities are `LOW`, `NORMAL`, `HIGH`, and `URGENT`. The status enum is `OPEN`, `IN_PROGRESS`, `AWAITING_APPROVAL`, `RESOLVED`, and `CLOSED`; new items start as `OPEN` and status changes use only the transition endpoint.

List queries support `status`, `priority`, `type`, `assigneeId`, and `q`. Use `assigneeId=unassigned` to find unassigned items. Search is case-insensitive across title and description. Filters are applied in PostgreSQL and only after scoping to the caller's memberships. Invalid filters and unknown parameters are rejected.

Pagination uses `limit` (default 25, maximum 100) and an opaque `cursor` returned as `nextCursor`. Items are sorted by `createdAt DESC, id DESC`; use the returned cursor unchanged in the next request:

```http
GET /api/items?status=OPEN&priority=URGENT&q=payment&limit=25
GET /api/items?limit=25&cursor=<nextCursor-from-previous-response>
```

The response contains `{ "items": [...], "nextCursor": "..." }`; `nextCursor` is `null` on the last page. Team membership is required to create an item. An optional assignee must also be a member of that same team. Attempts to supply unknown or server-controlled fields are rejected rather than ignored. Non-member team lookups return a generic not-found response.

Every create requires an `Idempotency-Key` header of 1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`. Keys are scoped to the authenticated user. The same key and canonical request replay the original `201` response; a different request with that key returns `409` (`IDEMPOTENCY_KEY_REUSED`). Successful records expire after 24 hours. Expired records are removed lazily when that same user/key is next used; a database cleanup job is not included.

Activity records are append-only through the API. Creation, updates, claims, transitions, and comments write the corresponding event in the business transaction. Activity reads return event/actor identifiers, type, timestamp, and non-secret metadata; descriptions and comment text are not copied into events. Comments are trimmed, 1–5,000 characters, and immutable after creation. Team members can list comments; Member, Lead, and Admin can create them. Unauthenticated requests return `401`; non-member item lookups return `404`.

`GET /api/items/dashboard` returns `{ "assignedToMe": [...], "unassignedUrgent": [...], "awaitingMyApproval": [...] }`. Each group is capped at 100 records and queried in PostgreSQL. The first two groups cover all of the caller's member teams; the approval group includes only teams where the caller currently has the Lead role.

## Run API and web in Docker Compose

Complete local setup steps 1–4 first so the database is migrated and seeded. Then build and start the API, outbox worker, and frontend containers:

```powershell
docker compose up --build -d api worker web
```

Open <http://localhost:5173>. Stop the containers with:

```powershell
docker compose down
```

PostgreSQL data is persisted in the `postgres_data` Docker volume. To delete this local development data too, run `docker compose down --volumes`.

## Database and development checks

Run from the repository root. Unit tests do not require a database. PostgreSQL integration suites are skipped unless `RUN_DATABASE_INTEGRATION_TESTS=1` is explicitly set. When enabled, a separate `TEST_DATABASE_URL` is mandatory; it must point directly to local PostgreSQL with no URL query parameters, fragment, service, socket, host override, or non-default port, and its database name must end in `_test` or `-test`. The test setup validates that URL before assigning it as the process database URL, and never falls back to `DATABASE_URL` or loads the root `.env` for comparison. If `DATABASE_URL` is already supplied in the process environment, normalized hostname, port, and database name are compared and an identical target is refused. The suffix is only a guardrail: it does not prove that the database is disposable or isolated. You must provision and verify a dedicated test database yourself; integration tests create and delete fixture users, teams, sessions, work items, and related records there. No test command automatically creates, resets, truncates, or deletes a database.

To run only the PostgreSQL integration suites, first provision a dedicated local test database separately from the development database. Then set the opt-in and test URL in a PowerShell session, run the integration script, and remove both variables afterward. Do not use the application's development database URL:

```powershell
$env:RUN_DATABASE_INTEGRATION_TESTS = "1"
$env:TEST_DATABASE_URL = "<local PostgreSQL URL ending in /newtonite_test>"
try {
  npm run test:integration --workspace @newtonite/api
} finally {
  Remove-Item Env:RUN_DATABASE_INTEGRATION_TESTS, Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
}
```

The ordinary `npm test` run leaves database integration opt-in unset and exercises database-independent backend and frontend tests. To update the existing demo accounts explicitly in a development shell, set `NODE_ENV` for that command; the guarded seed verifies the local Compose database and requires typed interactive confirmation:

```powershell
npm run db:migrate          # Create/apply a development migration
npm run db:migrate:deploy   # Apply committed migrations without creating one
$env:NODE_ENV = "development"
npm run db:seed              # Guarded update of existing demo accounts; typed confirmation required
Remove-Item Env:NODE_ENV
npm run build
npm run typecheck
npm run lint
npm test
npm run test:integration --workspace @newtonite/api # Requires explicit opt-in and TEST_DATABASE_URL above
npm test --workspace @newtonite/web
npm run worker               # Start the compiled outbox worker
```

The Prisma schema and migration history live in `database/prisma/`; Prisma CLI configuration remains in `backend/prisma.config.ts`. To run an individual app directly, use `npm run dev --workspace @newtonite/api` or `npm run dev --workspace @newtonite/web`.

`npm run db:migrate` creates/applies a local development migration; `npm run db:migrate:deploy` applies committed migrations. To start the worker directly, build first and keep the same `DATABASE_URL` configuration as the API. Compose uses the `worker` service with the same API image. Tune `OUTBOX_POLL_INTERVAL_MS` (default 1,000), `OUTBOX_MAX_ATTEMPTS` (8), `OUTBOX_BASE_DELAY_MS` (1,000), `OUTBOX_MAX_DELAY_MS` (300,000), and `OUTBOX_LOCK_TIMEOUT_MS` (300,000) through environment variables. Retry delays use bounded exponential backoff; stale processing locks can be reclaimed, and exhausted jobs are marked `FAILED` with a safe error category. The current handler verifies the durable activity reference and acknowledges the job; external integrations/notifications are deliberately not part of this phase.

Engineering rationale and trade-offs are recorded in [docs/ENGINEERING_DECISIONS.md](./docs/ENGINEERING_DECISIONS.md).

## Current scope and limitations

The frontend test suite uses Vitest with jsdom and React Testing Library. It covers cookie-session flows, dashboard loading/empty/error states, duplicate create prevention and idempotent retry behavior, version conflicts, claim/transition errors, comments, and role-aware controls. Tests mock the HTTP boundary; PostgreSQL-backed API integration and concurrency tests remain in the backend suite.

Phases 1–4 identity, sessions, team membership, safe seed behavior, work-item APIs, workflow, claims, version checks, idempotency, activity, comments, dashboard queries, and transactional outbox/worker remain in place. Phase 5 adds API-integrated frontend screens only; it does not change backend rules or add registration. The current API does not provide a team member directory, so assignee IDs are entered directly when creating or editing an item. Outbox execution is currently internal acknowledgement only; there is no broker, email, or notification integration. Expired idempotency rows are lazily removed only on key reuse, expired sessions are rejected but are not automatically cleaned, and job failures require operational inspection of the `OutboxJob` table. Rate limiting and password recovery remain out of scope.
