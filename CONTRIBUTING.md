# Working in this repository

Bastion is a TypeScript monorepo (pnpm workspaces, Turborepo). The implementation specification is
[`docs/tdd.md`](docs/tdd.md); read the sections you implement and section 5.4 before writing code.
Deviations are recorded in [`docs/adr`](docs/adr).

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install; run once per dependency change |
| `pnpm test` / `pnpm --filter @bastion-mcp/<pkg> test` | Unit and integration tests (integration skips without Docker) |
| `pnpm test:coverage` | Enforces 85% lines per package (23.5) |
| `pnpm typecheck` | `tsc --noEmit` for every package |
| `pnpm lint` / `pnpm lint:fix` | Biome |
| `pnpm boundaries` | `dependency-cruiser`: the package graph of section 5.3 |
| `pnpm db:generate` | Regenerate the Prisma client after editing `schema.prisma` |

`pnpm check` runs lint, typecheck, boundaries and tests.

## Rules

1. **Test first.** Write the failing test, watch it fail for the right reason, then implement. Name every
   test for a MUST with its section number: `it('6.5 forwards inputResponses to the same installation')`.
2. **No `any`, no non-null assertions.** Parse `unknown` with zod at every trust boundary: HTTP bodies,
   upstream results, Redis values, JSONB columns.
3. **Errors are `BastionError` subclasses** from `@bastion-mcp/core`. Stable `code`, `httpStatus`, `mcpCode`.
4. **Every outbound call has a timeout and an `AbortSignal`.** No unbounded awaits.
5. **Reuse before writing.** Shared constants, key builders, error types, naming, templates, address checks,
   AEAD tokens and canonical hashing live in `@bastion-mcp/core`. Do not re-implement them in a package;
   if a helper is needed by two packages, move it to `core` with a test.
6. **Ports and adapters.** Domain packages (`policy`, `limits`, `guards`, `router`, `overrides`, ...) define
   small interfaces for storage and I/O (`UserRepository`, `Clock`, `RedisLike`) and stay unit-testable.
   `@bastion-mcp/db` and `apps/server` provide the implementations and wire them together.
7. **Pure functions first.** Put decisions in pure functions that take data and return data; keep I/O in a
   thin shell around them.
8. **Package graph** (5.3) is enforced in CI. A package imports only what the graph allows, through its
   public `src/index.ts`.
9. **Never weaken a security default** to make a test pass (24.2).
10. **Pin every dependency** to an exact version (`save-exact`). Say in the commit why it was added.
11. Public functions in `packages/*` have unit tests; line coverage is at least 85% per package.

## Layout of a package

```
packages/<name>/
  package.json        name @bastion-mcp/<name>, "exports": { ".": "./src/index.ts" }
  src/index.ts        the public surface; everything else is internal
  test/*.test.ts      Vitest; *.integration.test.ts need Docker (use @bastion-mcp/testkit)
```
