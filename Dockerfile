# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY eslint-plugin-tuf ./eslint-plugin-tuf
RUN --mount=type=cache,target=/root/.npm npm install

COPY tsconfig.json ./
COPY .eslintrc.security.cjs ./
COPY scripts ./scripts
COPY src ./src

RUN npm run build \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true

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

USER 10001:10001
CMD ["node", "dist/app.js"]
