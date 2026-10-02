# Port conformance

`@bastion-mcp/db` implements the ports of the domain packages structurally and may not import those packages
(`.dependency-cruiser.cjs`, section 5.3). The conformance check therefore belongs to `apps/server`, which sees both
sides.

`ports.conformance.ts.txt` is a compile-time checker written against the real port types: one `satisfies` per port,
for example `pats: r.pats satisfies PatRepository`. It type-checked clean with `exactOptionalPropertyTypes: true`.
To use it:

1. Copy it to `apps/server/test/ports-conformance.test-d.ts`.
2. Replace the relative `../../<package>/src/...` imports with the package names (`@bastion-mcp/auth`, ...) and `../src/...` with `@bastion-mcp/db`.
3. Run `pnpm typecheck`. A failing assignment names the port and the property that differs.

`docs/port-matrix.md` lists every port, the db factory that implements it, its test and the schema mismatches that
were found while writing the repositories.

Optional adapters need collaborators only the server has: `createRepositories(db, deps)` enables `repos.scim`
(`scimConflictError`), `repos.keyStore` (`secretVault`), `repos.marketplaceStore` (`marketplaceAssemble`) and
`repos.installationRegistry` (`configHash`) when they are supplied.
