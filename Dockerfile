# syntax=docker/dockerfile:1.7

# Base image pinned to its multi-arch index digest (not the mutable `22-alpine`
# tag) so the registry can't swap the contents under us. Dependabot's docker
# ecosystem bumps this digest in a reviewed PR. Resolve a new one with:
#   docker buildx imagetools inspect node:22-alpine
FROM node:26-alpine@sha256:9c0e1e52125d6b67d505cf75b4880fcf1290ccea5c480849910e1d57b2cf72b5 AS builder

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

FROM node:26-alpine@sha256:9c0e1e52125d6b67d505cf75b4880fcf1290ccea5c480849910e1d57b2cf72b5 AS release

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

# Documentation only (does not publish the port). The default transport is stdio;
# set MCP_TRANSPORT=http and publish this port to run the HTTP transport.
EXPOSE 3000

ENTRYPOINT ["node", "build/index.js"]
