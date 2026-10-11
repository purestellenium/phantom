# Phantom as a plain Node server - the same shape it runs in on Orchard:
# installed and built with bun, served by `node build` on Node 22.
#
#   docker build -t phantom .
#   docker run -p 3000:3000 --env-file .env phantom
#
# Migrations are their own target, run as a release step before the new
# image takes traffic, so a crash-looping app container never half-applies
# one:
#
#   docker build --target migrate -t phantom-migrate .
#   docker run --rm --env-file .env phantom-migrate

# ── dependencies, dev ones included: the build and the migrator need them ──
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# ── the build ──────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
# The build loads the server config to analyse routes, and the config will
# not load without an ENCRYPTION_KEY and a DATABASE_URL. Throwaway ones live
# only in this command: nothing is encrypted and nothing connects at build
# time. The real values - from .env or the host's environment - are given to
# the running container, and .dockerignore keeps .env out of the image.
RUN ENCRYPTION_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
    DATABASE_URL="postgres://build:build@localhost:5432/build" \
    bun run build

# ── migrations: drizzle-kit plus the migration files and the script ──────
FROM deps AS migrate
COPY . .
CMD ["bun", "run", "db:migrate"]

# ── runtime dependencies only: adapter-node leaves them unbundled ─────────
FROM oven/bun:1 AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# ── the app ────────────────────────────────────────────────────────────────
FROM node:22-slim AS app
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    BODY_SIZE_LIMIT=12M
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "build"]
