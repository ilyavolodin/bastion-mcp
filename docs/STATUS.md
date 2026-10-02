# Build status

Updated 2026-10-02. Milestones follow `docs/tdd.md` section 24. "Verified" means exercised by an automated test in this
repo; items under "Not verified" have no passing test against the real thing.

## Built

| Piece | Milestone | Notes |
| --- | --- | --- |
| Monorepo, CI (`ci.yml`), Biome, Turborepo, package-graph enforcement (5.3), MUST-coverage tool (23.5) | M1 | `pnpm boundaries` scans `packages` and `apps` |
| `core`: ids, errors, constants, config, ServerSpec, templates, naming, SSRF/egress checks, AEAD, requestState, cursors, OSV | M1 | |
| `db`: Prisma schema (all of 16.2), migrations 0001-0003, repositories for every port, audit chain, partitions | M1 | Integration-tested on Postgres 17 |
| `secrets`, `telemetry`, `overrides`, `guards`, `limits`, `policy` | M2, M4-M6 | |
| `auth` (identity + OAuth AS + IdP login + upstream OAuth broker) | M2 | |
| `router`, `mcp-upstream`, `mcp-downstream` | M1 | Conformance and matrix results below |
| `sandbox`, `apps/runner` | M3 | Bubblewrap argv verified in a Linux container |
| `registry`, `plugins`, `apps/credential` | M7, M9 | |
| `api`, `api-client` (all of 17.2, OpenAPI 3.1) | M4 | Authorization table test for every route and role |
| `apps/web` (all 11 sections of 18.2, light and dark) | M4, M8 | Built on the generated client; Playwright smoke |
| `apps/server` (worker, ui, all-in-one, scheduler, CLI) | M1-M8 | 15 end-to-end journeys on real Postgres and Valkey |
| Helm chart, Dockerfiles, compose, release/nightly/weekly workflows, runbooks, admin and user guides | M8 | Chart validated with helm lint + kubeconform |

## Gate results

- **MCP conformance (`@modelcontextprotocol/conformance` 0.1.16):** 31 of 32 server scenarios pass on `/mcp/i/everything`
  and on a named endpoint. The remaining scenario has no failures, only resumability warnings the spec omits on purpose.
  The suite has no 2026-07-28 scenarios; the modern era is covered by SDK v2 matrix tests.
- **Compatibility matrix (23.2):** all rows run except the two Python SDK rows (no Python SDK here).
- **Proxy overhead (23.4):** met at 400 calls/s (p50 1.5 ms, p99 11 ms). At 667 calls/s on one worker p50 is met but p99
  is not (45-175 ms): the worker is CPU-bound on this laptop. The target (2,000 calls/s over 3 workers) is unverified.
- **Authorization:** 797 route/role cases against the real Cedar engine pass.

## Not verified

- Kubernetes driver against a real cluster (agent-sandbox, gVisor, kind); the cgroup v2 path.
- Real bubblewrap on a Linux host outside the test container; Dockerfile.sandbox build; Helm install on a cluster.
- Load, chaos and upgrade harnesses against a live deployment (written, never run end to end).
- CSP, CORS and `Secure` cookies in a real browser over real TLS.
- Plugin channels against real Claude Code, Codex, claude.ai and ChatGPT; the vendored Agent Plugins schemas
  (`packages/plugins/src/schemas.ts`) were reconstructed from the spec and must be diffed against the real ones.
- The performance targets at scale (5,000 listen streams, 500 sandboxes, 6 workers).

## Known gaps

- Lockfile capture for package servers in the catalog TEST flow; ID-JAG (enterprise-managed) wiring; RFC 7009 revocation
  on user deactivation; SCIM connection hot-reload.
- Web: call-span waterfall, Sankey and client topology, store install counts are dropped (the API has no data for them).
  Model-guard secrets are sent as `secret:NAME` (confirm the runtime resolver accepts that form).
- Spec deviations are in `docs/adr/0001-deviations.md`.
