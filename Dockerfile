# syntax=docker/dockerfile:1.7
#
# Expects a prebuilt `dist/` in the build context (CI: npm run build, then
# getsentry/action-release injects debug IDs before this image build).
# Local: run `npm run build` first, then `docker build`.

FROM node:22-bookworm-slim AS build

ARG GIT_SHA=

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    GIT_SHA=${GIT_SHA} \
    SENTRY_RELEASE=${GIT_SHA}

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        autoconf \
        automake \
        build-essential \
        libtool \
        python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY eslint-plugin-tuf ./eslint-plugin-tuf
RUN --mount=type=cache,target=/root/.npm npm ci

COPY dist ./dist

RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ARG GIT_SHA=

ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true \
    GIT_SHA=${GIT_SHA} \
    SENTRY_RELEASE=${GIT_SHA}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        default-mysql-client \
        fonts-noto-cjk \
        p7zip-full \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 tuf \
    && useradd --uid 10001 --gid tuf --create-home --home-dir /home/tuf tuf \
    && mkdir -p /app /srv/tuf/data/cache /srv/tuf/data/logs /srv/tuf/data/uploads \
    && chown -R tuf:tuf /app /srv/tuf /home/tuf

WORKDIR /app
COPY --from=build --chown=tuf:tuf /app/package.json ./
COPY --from=build --chown=tuf:tuf /app/node_modules ./node_modules
COPY --from=build --chown=tuf:tuf /app/dist ./dist

# Migrations are .cjs and outside the tsc include list, so they never reach dist/.
# sequelize-cli resolves these three paths relative to WORKDIR through .sequelizerc.
COPY --chown=tuf:tuf .sequelizerc ./
COPY --chown=tuf:tuf src/config/config.cjs ./src/config/config.cjs
COPY --chown=tuf:tuf src/database/migrations ./src/database/migrations

USER 10001:10001
CMD ["node", "dist/app.js"]
