# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder

WORKDIR /app

# Per-architecture, locked npm cache. The CI build is multi-platform
# (linux/amd64 + linux/arm64) and runs both arches concurrently; a cache mount
# whose id defaults to its target is shared between them, so two parallel
# `npm ci` runs write the same content-addressed cacache blob and collide with
# `EEXIST: rename _cacache/tmp -> _cacache/content-v2`. Scoping the id per
# $TARGETARCH gives each arch its own cache, and sharing=locked serializes any
# remaining concurrent access.
ARG TARGETARCH

COPY package.json package-lock.json ./
RUN --mount=type=cache,id=npm-$TARGETARCH,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS release

WORKDIR /app

ENV NODE_ENV=production

ARG TARGETARCH

COPY package.json package-lock.json ./
# No `npm cache clean` here: /root/.npm is a cache mount, not part of the image
# layer, so cleaning it never shrinks the image — it only wipes the shared cache
# and adds another writer that can race the builder stage.
RUN --mount=type=cache,id=npm-$TARGETARCH,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/build ./build

USER node

ENTRYPOINT ["node", "build/index.js"]
