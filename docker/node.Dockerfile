# Shared image for indexer / api / mcp (SERVICE build arg picks the entrypoint).
# bookworm-slim (glibc) because onnxruntime-node prebuilds don't run on musl.
FROM node:22.23.1-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

# git: the indexer shells out to `git log` on the read-only mounted repos.
# openssh-client + rsync: fleet sync (spec §4) — the indexer shells out to
# `ssh`/`rsync` to pull other machines' code + Claude transcripts into
# remote_mirror. Unused by api/mcp, but one shared image (SERVICE build arg)
# means every service pays the ~2MB either way.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client rsync \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system safe.directory '*'

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/indexer/package.json packages/indexer/
COPY packages/api/package.json packages/api/
COPY packages/mcp/package.json packages/mcp/
COPY packages/cli/package.json packages/cli/
RUN npm ci --no-audit --no-fund --workspace packages/core --workspace packages/indexer \
    --workspace packages/api --workspace packages/mcp --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/indexer packages/indexer
COPY packages/api packages/api
COPY packages/mcp packages/mcp
RUN npm run build -w packages/core \
  && npm run build -w packages/indexer -w packages/api -w packages/mcp

ARG SERVICE=api
ENV SERVICE=${SERVICE} \
    NODE_ENV=production \
    HF_HOME=/app/.cache \
    XDG_CACHE_HOME=/app/.cache

CMD ["sh", "-c", "node packages/${SERVICE}/dist/main.js"]
