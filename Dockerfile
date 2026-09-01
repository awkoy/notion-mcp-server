# syntax=docker/dockerfile:1.7

# Base image pinned to its multi-arch index digest (not the mutable `24-alpine`
# tag) so the registry can't swap the contents under us. Dependabot's docker
# ecosystem bumps this digest in a reviewed PR. Resolve a new one with:
#   docker buildx imagetools inspect node:24-alpine
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS builder

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

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS release

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

# No HEALTHCHECK by default. The default transport is stdio, where nothing
# listens, so a probe of /health would mark every stdio container unhealthy.
# For an HTTP deployment (MCP_TRANSPORT=http) uncomment the line below, or pass
# the same command as `docker run --health-cmd` / a compose `healthcheck:` —
# see the README's "Remote / HTTP transport" section.
# HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
#   CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "build/index.js"]
