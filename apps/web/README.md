# @bastion-mcp/web

The Bastion admin console (TDD section 18): a React 19 SPA served by the `ui` role. It talks only to the
control-plane REST API at `/api/v1` (17) and receives live updates from `GET /api/v1/events` (SSE).

Stack (5.1): Vite 7, TanStack Router and Query, Tailwind CSS 4 with the Zest tokens as CSS variables (light and
dark), shadcn/ui on Radix (`src/components/ui`), Lucide, Recharts 3, Monaco (JSON and Cedar, lazy loaded,
bundled locally, no CDN), react-hook-form + zod.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm --filter @bastion-mcp/web dev` | Vite dev server with the in-browser MSW API (`VITE_MOCK_API=true`): the whole UI is explorable without a backend. `?as=admin\|manager\|member\|auditor` picks the signed-in role. |
| `pnpm --filter @bastion-mcp/web dev:api` | Dev server proxying `/api`, `/auth`, `/oauth` and `/mcp` to `BASTION_URL` (default `http://localhost:8080`). |
| `pnpm --filter @bastion-mcp/web build` | Typecheck, then `vite build` to `apps/web/dist`. |
| `pnpm --filter @bastion-mcp/web test` | Vitest + Testing Library + MSW (jsdom). `test:coverage` enforces 70% lines. |
| `pnpm --filter @bastion-mcp/web e2e` | Playwright smoke and axe checks against the MSW dev server. |
| `pnpm --filter @bastion-mcp/web screenshots` | Writes light and dark screenshots of the main screens to `screenshots/`. |

## Serving the build

`vite build` writes the static SPA to `apps/web/dist`. The server image copies it into `apps/server/public`
(for example `COPY --from=web /app/apps/web/dist /app/apps/server/public`) and `@fastify/static` serves it
with an `index.html` fallback for client-side routes. The MSW worker (`mockServiceWorker.js`) is removed from
`dist` in non-mock builds.

## Role-aware UI

`GET /api/v1/me` decides everything (`src/lib/roles.ts`): the sidebar sections (18.2), route guards (the
"Not in this role's navigation" screen), and elements inside screens (`RoleGate`, `Guard`). A user who manages
a team is a Manager (10.1). A dev-only role preview bar exists behind `?rolePreview=1` (sticky for the tab,
`?rolePreview=0` turns it off); it is off by default and never shown otherwise. Light is the default theme for
everyone; dark is stored per user through `PATCH /me`.

## The API layer

All network access lives in `src/api/`, and every request and response type comes from the generated client
(`@bastion-mcp/api-client`, built from the API's OpenAPI document):

- `client.ts`: the typed `api` (CSRF double submit with `x-bastion-csrf` from `bastion_csrf`, RFC 9457 problem+json to
  `ApiError`, ETag remembered per path and sent as `If-Match`, cursor pagination via `fetchAll`, timeout and abort on
  every call, 401 redirect to `/auth/login`). The path decides the body, the query and the response:
  `api.post('/teams', body)` only compiles when `/teams` has a POST and `body` is its request body.
- `schema.ts`: `Schemas['Team']`, `Body<'post', '/teams'>`, `Res<...>`, `Query<...>`: nothing is restated by hand.
- `views/<domain>.ts`: view models for screens that join or derive data (names from other lists, letter and tint from
  the name, status chips), defined over the generated types with pure mappers.
- `hooks/<domain>.ts`: TanStack Query hooks, one file per domain (`pagedQuery` for lists).
- `events.ts`: the SSE stream; its payloads are the only shapes OpenAPI cannot describe, so they are hand-written.

Forms collect every field the API requires and validate with the same limits (slugs are derived from the name with
core's `slugify`). Each form builds its body with a typed `toBody`.

## The mock API and the contract tests

`src/mocks/domains/<domain>.ts` is the MSW mock of one route group. Handlers are written with
`route.get('/teams/{id}', ...)` (`src/mocks/http.ts`), so the path is an operation of the OpenAPI document and the
answer has the operation's response type; the rows in `db.data.<domain>` have the exact API shape.
`src/api/route-contract.test.ts` fails when the UI calls a route the API does not have or the mock does not answer,
and validates every sample request and every response page of the mock with ajv against the JSON schemas of
`packages/api-client/openapi.json`. Each form has a test that submits through the real screen, captures the body that
went over the wire (`src/test/capture.ts`) and validates it against the request schema.

Reconciliation decisions (also in `docs/adr/0001-deviations.md`, section 7):

| UI assumption | Decision |
| --- | --- |
| `POST /policy-rules/preview` | Removed; the rule dialog points to the policy simulator. |
| `PATCH /catalog/{id}/versions/{vid}` | Added to the API (draft-only edit, `catalog.update`). |
| `GET /catalog?needsApproval=true` | Replaced: plugin entries, then draft versions, keeping `approval.status === 'pending'`. |
| `POST /installations/{id}/egress` | Removed; the Network tab shows `GET .../egress` decisions grouped per host. |
| `/me` `org.*`, `capabilities.*` | Added to the API's `GET /me`. |
| theme in `PATCH /me` | Per-browser (`localStorage`); `PATCH /me` edits `displayName` only. |
| `GET .../versions/{vid}/test` as JSON | It is an SSE stream: the Test panel reads the run from the version row and polls. |
| default endpoint client config | `GET /client-config` (added): the default `/mcp` endpoint has no row. |
| stats by client, call spans | Not in the API: the Sankey, topology and waterfall are replaced by rankings and the call row. |

`@bastion-mcp/core` is imported for constants, the org-settings schema and `slugify` only, through the browser-safe
subpaths `@bastion-mcp/core/constants`, `@bastion-mcp/core/org-settings` and `@bastion-mcp/core/ids` (aliased in
`vite.config.ts` and `tsconfig.json`), because the package barrel and `server-spec` pull in Node-only modules; the
`ServerSpec` constraints are mirrored in the catalog editor and checked against the OpenAPI schema by the tests.

## Layout

```
src/api          network layer (the only place that calls fetch)
src/auth         /me bootstrap, role and theme context
src/components   shared components (StatusDot, Sparkline, Tag, Card, EmptyState, Stepper, DiffView,
                 CopyField, ChartCard with table toggle, RoleGate, ...) and ui/ (shadcn primitives)
src/features     one folder per screen of 18.2
src/mocks        MSW handlers and Acme fixtures (dev, tests, screenshots)
src/test         Vitest setup and screen-level tests
e2e              Playwright smoke, axe and screenshot specs
```
