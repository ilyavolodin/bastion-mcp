# ADR 0001: Deviations from the technical design

`docs/tdd.md` is the source of truth (24.2). Where an implementation choice differs from it, the
difference is recorded here, and the document is edited to match once the owner agrees.

## 1. Prisma instead of Drizzle (sections 5.1, 5.2, 16)

**Decision.** `packages/db` uses Prisma 7 (`prisma`, `@prisma/client`, `@prisma/adapter-pg`) instead of
`drizzle-orm` and `drizzle-kit`. Requested by the project owner for easier future schema updates.

**Consequences.**

- `packages/db/prisma/schema.prisma` is the schema source. Migrations are Prisma migrations
  (`prisma migrate dev` while developing, `prisma migrate deploy` for `bastion migrate`).
- The first migration (`0001_init`) was generated from the schema, then supplemented by hand with what
  Prisma cannot express: the `citext` extension, `PARTITION BY RANGE ("ts")` on `call_log`,
  `egress_events` and `distribution_events`, `CHECK` constraints, partial and expression indexes, and the
  partition helper functions. Future migrations that touch those objects are edited the same way.
- Closed value sets are `text` plus `CHECK` constraints exactly as section 16.2 specifies, not Prisma enums,
  so `@bastion-mcp/core` constants stay the single source. `schema-conformance.test.ts` fails when a
  `CHECK` list and the matching core constant drift apart.
- Section 5.3 lists `drizzle schema` under `db`; read that as "Prisma schema, migrations, repositories".

## 2. `call_stats_*` primary keys

Section 16.2 puts nullable `installation_id` and `item_name` in the primary key of `call_stats_minute`,
which Postgres rejects. They are `NOT NULL` with defaults (nil UUID, empty string) meaning "not
attributed". `call_stats_hour` and `call_stats_day` ("same columns") are separate models.

## 3. Internal packages are consumed as TypeScript source

Section 5.1 names `tsdown` for package builds. Workspace packages export `./src/index.ts` and are bundled
into the deployable artifacts (`apps/server`, `apps/runner`, `apps/credential`) by `tsdown` or `esbuild`.
Development runs through `tsx` and Vitest. This removes a build step from the inner loop and does not change
the package graph, which `dependency-cruiser` still enforces (5.3).

## 4. Tooling versions

TypeScript 5.9 and Vitest 3 follow section 5.1. Prisma is pinned to the stable 7.10.0 line (the `latest`
dist-tag currently points at an 8.0 release candidate).

## 5. Cedar schema and policy generation (`packages/policy`)

- **Per-action resource types.** `seeTool`/`callTool` apply to `Tool`; prompt actions to `Prompt`; resource actions to
  `Resource`; `useInstallation` to `Installation`. The spec lists all four types for every action, under which the
  10.3 example policies fail strict validation (`resource.destructive` does not exist on the other types).
- **`User.managedTeams: Set<Team>`** is added so templates can express "manager of team T".
- **Read-only views** of org settings, users, teams, IdP, guards and limits use `seeCatalog` on `Org` (no action exists).
- **Self-service routes** (`/me`, own tokens, own grants) have no Cedar action.
- **Org-wide publishing and manager call-log visibility** are data-driven (`orgWidePublisherIds`,
  `settings.logsManagerVisibility`), because management actions have an empty context.
- Managers edit entries whose owner team they manage; "edit own entries" is not implemented (no creator attribute).
