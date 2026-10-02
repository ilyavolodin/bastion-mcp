# Build status

Updated as work lands. Milestones follow `docs/tdd.md` section 24; "gate" is the milestone's exit gate.

| Piece | Milestone | State |
| --- | --- | --- |
| Monorepo, CI, Biome, Turborepo, boundaries (5.3), MUST-coverage tool (23.5) | M1 | done |
| `core`: ids, errors, constants, config loader, ServerSpec, templates, naming, net/SSRF, AEAD, requestState, cursors, OSV | M1 | done (124 tests) |
| `db`: Prisma schema for all of 16.2, migration (partitions, CHECKs, citext), audit chain, config versions | M1 | done, integration-tested on Postgres 17 |
| SDK spikes (24.2 a, b, c) | M1 | done: `docs/spikes/m1-sdk-2.2.md` |
| `secrets`, `telemetry`, `overrides`, `guards`, `limits`, `policy` | M2, M4, M5, M6 | in progress |
| `sandbox` + `apps/runner` | M3 | in progress |
| `registry` | M7 | in progress |
| `plugins` + `apps/credential` | M9 | in progress |
| `auth`, `router`, `mcp-upstream`, `mcp-downstream`, `api`, `api-client` | M1, M2, M4 | not started |
| `apps/server`, `apps/web`, Helm chart, images | M4, M8 | not started |
