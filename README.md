# Bastion

Self-hosted, open-source (Apache-2.0) MCP gateway: one URL per user, SSO, roles and teams, an internal
store of curated servers, per-user upstream credentials, sandboxed local servers, overrides, security
guards, limits, OpenTelemetry and a skills and plugin repository.

- Specification: [`docs/tdd.md`](docs/tdd.md)
- UI design: [`docs/design`](docs/design) (Bastion Admin Console, Zest design system)
- Working in the repo: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Deviations from the spec: [`docs/adr`](docs/adr)
- Build status by milestone: [`docs/STATUS.md`](docs/STATUS.md)

```
pnpm install
pnpm db:generate
pnpm check
```
