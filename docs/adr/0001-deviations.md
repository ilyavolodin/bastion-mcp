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

## 6. Sandbox claim names use the tail of the id

Section 8.4 names claims `bst-<instanceId first 12 hex>` and `bsp-<installationId first 12 hex>`. For UUIDv7 the
first 12 hex digits are a millisecond timestamp, so ids created in the same millisecond collide. Names use the LAST
12 hex digits (the random part) instead.

## 7. Console reconciliation with the API (`apps/web`)

- `GET /me` also returns `org` (`name`, `host`, `traceUiUrl`, `toolWarnThreshold`) and `capabilities`
  (`registry`, `publishOrgWide`, `personalInstalls`, from Cedar and org settings), so members need no Admin-only
  `/settings` read. `traceUiUrl` comes from `BASTION_TRACE_UI_URL` through `ApiConfig.traceUiUrl`.
- `PATCH /catalog/{id}/versions/{vid}` edits a draft version in place (published versions answer 409
  `version_immutable`); it uses the `catalog.update` rule.
- The theme is a per-browser preference: `PATCH /me` edits the display name only.
- No live "affected people and tools" count for policy rules (the console points to the simulator), no
  "request network access" button (no route; admins edit the allowlist), and executable-content approvals are
  found by walking plugin entries and their draft versions' `approval` status instead of a list filter.

- Every response of a stored resource is a named schema (`User`, `Team`, `Installation`, `CatalogEntry`, ...; see
  `packages/api/src/schemas/rows.ts`) that mirrors the store row: one field per column, camelCase, ISO dates, `null`
  for nullable columns. They are open objects, so a column added later is not a breaking change. The OpenAPI document
  carries them as `components.schemas.*` and `@bastion-mcp/api-client` generates a precise type for each; list
  responses are named pages (`TeamPage`, ...). Other loose responses were tightened the same way (definitions,
  egress, overrides preview, rollout, model guards, call records, findings, notifications, test runs, installForm).
  Everything is additive or a tightening of a previously untyped field, so `openapi:check` reports compatible changes
  only. The in-memory test store fills the column defaults of the database so API tests exercise the same rows.
- `GET /client-config?client=&auth=` returns the client configuration of the default `/mcp` endpoint (it has no
  endpoint row, so `GET /endpoints/{id}/client-config` cannot serve it); it uses the `installations.personal` rule.
- The console takes every request and response type from the generated client (`src/api/schema.ts`); screens that
  need joined or derived data (names, letters, status chips) build view models over the generated types in
  `src/api/views`. The MSW mock is typed by the same types and `src/api/route-contract.test.ts` validates every
  sample request and every response, page by page, against the OpenAPI schemas with ajv.
- Console features dropped because the API has no source for them: the span waterfall and sandbox phases of a call,
  per-finding before/after text, the client to installation Sankey and the topology view (statistics have no client
  dimension; `@xyflow/react` is no longer a dependency of the console), install counts and popularity in the store,
  the per-user "hide" of an installation, tool counts on installation rows, sparklines, the "Runs code" and "parts"
  tags of catalog and plugin lists, queue capacity and uptime in the system status, and OAuth client display names.
  The Traffic flow card of the observability screen is a ranking of installations by calls.
- A policy rule, a limit rule, a role-mapping rule and a service account are created with the fields the API
  requires (`name`, `priority`, `slug`, `authMethod`, `idpConnectionId`, ...); service-account credentials are shown
  once; install-request rejections and drift rejections ask for the required `reason`.

## 8. Bubblewrap startup probe binds the root (8.5)

The probe `bwrap --unshare-user --unshare-net true` of 8.5 cannot succeed: with no binds bwrap starts an empty
filesystem, so `execvp true` fails even on hosts where bubblewrap works. The probe adds `--ro-bind / /`, which still
fails when unprivileged user namespaces or network unsharing are unavailable (what the probe is for).
