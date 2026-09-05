# DOLMIR API — one process that serves HTTP and works the background queue.
#
# Three stages. `build` has every dependency and compiles TypeScript; `deps`
# installs only what runs in production; `runtime` takes the compiled output
# and the production dependencies and nothing else — no sources, no dev tools,
# no package manager, no shell needed to start.
#
# No secret is ever an ARG, an ENV or a file here. Configuration arrives in the
# container's environment at run time (see docs/deployment.md), and the
# process refuses to start until the production set is complete.
#
#   docker build -t dolmir-api .
#   docker run --rm --env-file <your secret store's export> -p 3000:3000 dolmir-api
#
# Deploy steps, with the owner connection, before starting the new version:
#   docker run --rm --env-file … dolmir-api node apps/api/dist/cli/main.js migrate
#   docker run --rm --env-file … dolmir-api node apps/api/dist/cli/main.js jobs:install
#   docker run --rm --env-file … dolmir-api node apps/api/dist/cli/main.js preflight

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
# The pnpm version is pinned by `packageManager` in package.json; corepack
# resolves exactly that one.
RUN corepack enable
WORKDIR /app

# Manifests only, so dependency installation is cached until a manifest changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/core/package.json packages/core/
COPY packages/systems/commercial-inbox/package.json packages/systems/commercial-inbox/

# ---------------------------------------------------------------------------
FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/
COPY packages/core/tsconfig.json packages/core/
COPY packages/systems/commercial-inbox/tsconfig.json packages/systems/commercial-inbox/
COPY apps/api/src apps/api/src
COPY packages/core/src packages/core/src
COPY packages/systems/commercial-inbox/src packages/systems/commercial-inbox/src
RUN pnpm build

# ---------------------------------------------------------------------------
FROM base AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# A system account with no password, no login shell and no home to write to.
# The object store is a volume mounted at DOLMIR_STORAGE_LOCAL_ROOT and must be
# writable by this user (uid shown by `docker run --rm <image> id`).
RUN groupadd --system dolmir \
 && useradd --system --gid dolmir --no-create-home --home-dir /app --shell /usr/sbin/nologin dolmir

# Production dependencies and the workspace layout they were installed into.
COPY --from=deps --chown=dolmir:dolmir /app /app
# Compiled output only. The package manifests resolve `default` → dist, so no
# source and no `--conditions` flag is involved at run time.
COPY --from=build --chown=dolmir:dolmir /app/apps/api/dist apps/api/dist
COPY --from=build --chown=dolmir:dolmir /app/packages/core/dist packages/core/dist
COPY --from=build --chown=dolmir:dolmir /app/packages/systems/commercial-inbox/dist packages/systems/commercial-inbox/dist
# Read at run time: readiness reports pending migrations, and `migrate` applies them.
COPY --chown=dolmir:dolmir supabase/migrations supabase/migrations

USER dolmir
EXPOSE 3000

# Liveness only: "the process answers". Readiness — database, migrations,
# workers — is GET /health/ready, for the orchestrator's readiness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.DOLMIR_HTTP_PORT || '3000') + '/health/live').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Node is PID 1 and handles SIGTERM itself (apps/api/src/main.ts); `--init` is
# optional. Workers start before the listener, and a failure to start them
# stops the process — there is no mode that serves HTTP without them.
CMD ["node", "apps/api/dist/main.js"]
