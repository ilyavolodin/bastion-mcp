# syntax=docker/dockerfile:1.7
# ghcr.io/bastion-mcp/bastion (tdd 20.1). Build context: the repository root.
#   docker buildx build -f deploy/docker/Dockerfile -t bastion --platform linux/amd64,linux/arm64 .
#
# BUILD CONTRACT with the workspace (apps/server and apps/web do not exist yet in this repository; this file
# assumes the following and must be updated together with them):
#   1. `pnpm db:generate` generates the Prisma client (packages/db); `pnpm --filter @bastion-mcp/api-client generate`
#      generates the API types the SPA is typechecked against (both outputs are ignored by git and the context).
#   2. `pnpm --filter @bastion-mcp/web exec vite build` (the typecheck half of `build` is CI) writes the SPA to apps/web/dist; this file copies it to
#      apps/server/public (served by @fastify/static).
#   3. `pnpm --filter @bastion-mcp/server build` bundles apps/server with tsdown/esbuild into
#      apps/server/dist/main.js and apps/server/dist/otel.js (ESM, target node24). Workspace packages and the
#      generated Prisma client are inlined; native or non-bundleable dependencies (re2, @node-rs/argon2, ...)
#      stay external and must be listed under "dependencies" of apps/server/package.json.
#   4. `node dist/main.js <command>` dispatches the CLI of 20.1 (migrate, check-config, create-admin,
#      rotate-keys, export-config, import-config); the `bastion` wrapper installed below calls it.
#   5. Migrations live in packages/db/prisma/migrations and are copied to /app/prisma for `bastion migrate`.
#   6. `pnpm --filter bastion-runner build` writes apps/runner/dist/runner.mjs (same as Dockerfile.sandbox).
# Nothing here is arch-specific: the Node binary of the sandbox runtime is copied from the official image of the
# target platform, and uv is downloaded for `uname -m`.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- build: install, generate, build SPA, bundle server and runner -----------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=true
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Lockfile and manifests first so the install layer caches until dependencies change.
# tsconfig.base.json and vitest.shared.ts are extended/imported by every workspace package (prisma generate, vite, tsdown).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json vitest.shared.ts ./
COPY apps ./apps
# The server bundles the sandbox seccomp profile (inlined at build time).
COPY deploy/docker/sandbox-seccomp.json ./deploy/docker/sandbox-seccomp.json
COPY packages ./packages
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm db:generate
# The SPA is typechecked against the generated API types (src/generated is excluded from the build context).
RUN pnpm --filter @bastion-mcp/api-client generate
# Typechecking is CI (`pnpm typecheck`); the image build only bundles the SPA.
RUN pnpm --filter @bastion-mcp/web exec vite build \
 && mkdir -p apps/server/public \
 && cp -r apps/web/dist/. apps/server/public/
RUN pnpm --filter @bastion-mcp/server build
RUN pnpm --filter bastion-runner build
# Production dependencies only, laid out as a standalone directory (pnpm 10 needs --legacy without
# inject-workspace-packages).
RUN pnpm --filter @bastion-mcp/server deploy --legacy --prod /out \
 && cp -r apps/server/dist /out/dist \
 && cp -r apps/server/public /out/public \
 && cp -r packages/db/prisma /out/prisma

# ---- sandbox runtime for the bubblewrap driver: /opt/runtime -----------------------------------------------
FROM ${NODE_IMAGE} AS runtime-tools
ARG UV_VERSION=0.8.22
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/runtime/bin \
 && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-$(uname -m)-unknown-linux-gnu.tar.gz" \
    | tar -xz --strip-components=1 -C /opt/runtime/bin \
 && UV_PYTHON_INSTALL_DIR=/opt/runtime/python UV_PYTHON_BIN_DIR=/opt/runtime/bin \
    /opt/runtime/bin/uv python install 3.13 \
 && chmod -R a+rX /opt/runtime

# ---- runtime -------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    BASTION_DATA_DIR=/var/lib/bastion \
    BASTION_GIT_CACHE_DIR=/var/cache/bastion/git \
    BASTION_HTTP_PORT=8080 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini bubblewrap git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 bastion \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /var/lib/bastion --shell /usr/sbin/nologin bastion \
 && mkdir -p /var/lib/bastion /var/cache/bastion/git /opt/bastion /app \
 && chown -R 10001:10001 /var/lib/bastion /var/cache/bastion

# Bundled sandbox runtime (8.5): Node 24, uv, Python 3.13, git. /usr is bound read-only into each jail, so git and
# the shared libraries Node needs come from the base image.
COPY --from=runtime-tools /opt/runtime /opt/runtime
COPY --from=runtime-tools /usr/local/bin/node /opt/runtime/bin/node
# npm (the runner installs npm packages with it, 8.3): the sandbox PATH is /opt/runtime/bin:/usr/bin, so the npm that
# ships with the Node image under /usr/local is not visible inside a jail.
COPY --from=runtime-tools /usr/local/lib/node_modules/npm /opt/runtime/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /opt/runtime/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /opt/runtime/bin/npx \
 && ln -s /usr/bin/git /opt/runtime/bin/git \
 && ln -sf "$(ls -d /opt/runtime/python/cpython-3.13*/bin/python3.13 | head -n1)" /opt/runtime/bin/python3 \
 && ln -sf python3 /opt/runtime/bin/python
COPY --from=build /src/apps/runner/dist/runner.mjs /opt/bastion/runner.mjs

WORKDIR /app
COPY --from=build --chown=10001:10001 /out/ /app/
RUN printf '#!/bin/sh\nexec node /app/dist/main.js "$@"\n' > /usr/local/bin/bastion \
 && chmod 0755 /usr/local/bin/bastion

USER 10001:10001
EXPOSE 8080 7443 3128
VOLUME ["/var/lib/bastion"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.BASTION_HTTP_PORT||8080)+'/healthz',{signal:AbortSignal.timeout(2500)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["tini", "--", "node", "--import", "./dist/otel.js", "./dist/main.js"]
