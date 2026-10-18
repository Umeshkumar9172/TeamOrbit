# Engineering decisions

## Product branding

- **The user-facing product name is TeamOrbit.** The tagline is “One Workspace. Every Task. Clear Accountability.” Technical repository names, npm workspace identifiers, API routes, database names, and Docker service names retain the Newtonite identifiers to avoid changing established integration contracts.

## Repository organization

- **Applications and database assets are separated by responsibility.** The existing npm workspaces retain their package names while moving to `backend/` and `frontend/`; Prisma schema and migration history live under `database/prisma/`, and engineering decisions live in `docs/`. Prisma CLI configuration remains beside the API workspace because it drives backend scripts. This preserves existing commands and deployment boundaries without introducing shared-code packages or changing runtime behavior.

## Phase 5 — frontend integration

- **The UI consumes the existing HTTP contract without duplicating business rules.** Authentication uses the HttpOnly session cookie through `credentials: include`; team scoping, approval eligibility, optimistic locking, and mutation validation remain server-authoritative. The UI uses membership roles only to present relevant controls and still surfaces server denials.
- **The list follows the API's keyset contract.** Supported filters are sent unchanged and the opaque `nextCursor` is passed back only for load-more requests; there is no client-side offset emulation or broad data filtering.
- **Create retries preserve idempotency.** A request signature is paired with a generated key while create outcome is uncertain. Identical retries reuse that key; a changed payload gets a new key; in-flight submissions are locked.
- **Frontend interactions use the existing Vitest toolchain.** jsdom and React Testing Library were added as test-only dependencies to verify auth and UI mutation states without changing backend or runtime dependencies.

## Phase 4 — workflow and reliability

- **Workflow is explicit and forward-only.** The API allows only `OPEN → IN_PROGRESS → AWAITING_APPROVAL → RESOLVED → CLOSED`; no new states or skip/reopen transitions are introduced. Team writers may initiate each step except approval out of `AWAITING_APPROVAL`, which requires a current `LEAD` membership in the item's own team. Admin is intentionally not treated as Lead. This errs conservatively where the challenge left initiator roles unspecified.
- **Claims are narrow and atomic.** A team Member, Lead, or Admin can claim only an unassigned `OPEN` item. PostgreSQL conditional updates compare team, state, assignment, and supplied version as one mutation. This avoids an application read-then-write race without introducing a separate lock service.
- **Versions are mandatory concurrency tokens.** Update, claim, and transition bodies include the current `version`. A conditional database update increments the version and writes its event/outbox row in one transaction. Mutations lock the caller's membership row while checking its current role so a concurrent role change cannot race authorization. A stale request gets a non-disclosing `409` and a reload path rather than a snapshot that could expose an unauthorized item.
- **Idempotency is per user and time-bounded.** The unique `(userId, key)` record stores a SHA-256 fingerprint of canonical validated input and the safe JSON create response. Record insertion, item creation, activity, outbox, and response persistence share one transaction. This prevents partial success and lets PostgreSQL arbitrate concurrent duplicates. Records expire after 24 hours and expired entries are deleted lazily when the same key is reused; a scheduled cleanup job is deferred.
- **Activity and comments are transactionally durable.** Activity rows and outbox jobs are inserted with the associated mutation. API routes expose activity reads only and do not expose event editing/deletion. Comments are immutable and their full text stays in the Comment table, not the activity metadata.
- **The outbox uses PostgreSQL rather than a broker.** Workers claim with `FOR UPDATE SKIP LOCKED`, then re-lock the job row while handling and completing it, persist an attempt/lease, retry with bounded exponential delay, and recover stale leases. The present handler validates that the activity event exists and matches the job type, then acknowledges it; no external side effect is enabled in this phase. This keeps the event/worker lifecycle operational without choosing a notification or broker contract prematurely.
- **Dashboard filtering stays in SQL.** The three dashboard result groups are selected directly by authorized team IDs and role-specific approval teams, with a 100-item cap and supporting work-item indexes; records are not loaded broadly and filtered in Node.
- **Migrations are additive.** Phase 4 adds a migration for history, comments, idempotency, outbox state, and dashboard indexes without rewriting the identity/work-item migrations. Development seed behavior and credentials are unchanged.
