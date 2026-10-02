# @bastion-mcp/web

The Bastion admin console (TDD section 18): a React 19 SPA served by the `ui` role. It talks only to the
control-plane REST API at `/api/v1` (17) and receives live updates from `GET /api/v1/events` (SSE).

Stack (5.1): Vite 7, TanStack Router and Query, Tailwind CSS 4 with the Zest tokens as CSS variables (light and
dark), shadcn/ui on Radix (`src/components/ui`), Lucide, Recharts 3 (including Sankey), `@xyflow/react`
(topology view), Monaco (JSON and Cedar, lazy loaded, bundled locally, no CDN), react-hook-form + zod.

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

## The API layer and swapping in `@bastion-mcp/api-client`

All network access lives in `src/api/`:

- `client.ts`: typed fetch wrapper (CSRF double submit with `x-bastion-csrf` from `bastion_csrf`, RFC 9457
  problem+json to `ApiError`, ETag remembered per path and sent as `If-Match`, cursor pagination via
  `fetchAll`, timeout and abort on every call, 401 redirect to `/auth/login`).
- `types.ts`: DTOs written by hand from 17.2 and the data model.
- `hooks/*.ts`: TanStack Query hooks, one per route group.
- `events.ts`: SSE subscription and cache updates.

To switch to the generated client: add `@bastion-mcp/api-client` to `package.json`, re-implement `request()` in
`client.ts` on top of it (keeping the `ApiError` mapping, CSRF header and ETag handling), and replace the
hand-written DTOs in `types.ts` by re-exports of the generated schema types. Screens and hooks do not change.

Routes the UI uses that are not in 17.2 (assumptions to confirm when the OpenAPI document lands):
`POST /policy-rules/preview` (live affected count), `PATCH /catalog/{id}/versions/{vid}` (edit a draft),
`GET /catalog?needsApproval=true` (executable-content approvals), `POST /installations/{id}/egress` (request
access) and the `/me` fields `org.traceUiUrl`, `org.toolWarnThreshold` and `capabilities.*`.

`@bastion-mcp/core` is imported for constants and the org-settings schema only, through the two browser-safe
subpaths `@bastion-mcp/core/constants` and `@bastion-mcp/core/org-settings` (aliased in `vite.config.ts` and
`tsconfig.json`), because the package barrel pulls in Node-only modules.

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
