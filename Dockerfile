# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Papyrus — durable agent runtime on Wolfi (Chainguard)
#
# Wolfi provides Node, Python, and busybox sh via apk, with continuously-scanned
# minimal packages. The runtime is one Wolfi base with exactly the packages the
# daemon, the document toolchain, and the workspace sandbox's `/bin/sh -c` need.
# ---------------------------------------------------------------------------

# ---- build: resolve deps, compile server + web ----
FROM cgr.dev/chainguard/wolfi-base AS build

ARG TARGETARCH

# pnpm must come from npm, not apk: Wolfi currently ships pnpm 11.22.0, which
# contains the pnpm#13617 worker-lifecycle bug — `pnpm install --prod` prints
# "Done in Xs" and then never exits. Node's event loop stays alive because a
# straggler worker fetch (triggered by the foreign-architecture optional deps we
# request through supportedArchitectures) lazily recreates the worker pool after
# finishWorkers() has cleared it. Inside a Docker RUN that is a silent deadlock:
# the step never prints DONE and BuildKit waits forever at 0% CPU.
# Fixed in pnpm 11.23.0 (pnpm#13226); pinned to 11.26.0.
RUN apk add --no-cache nodejs-24 npm ca-certificates-bundle \
 && npm install -g --no-fund --no-audit pnpm@11.26.0 \
 && pnpm --version

WORKDIR /src
COPY . .

RUN pnpm install --node-linker=hoisted \
      --config.supportedArchitectures.os=linux \
      --config.supportedArchitectures.cpu=${TARGETARCH} \
      --config.supportedArchitectures.libc=musl \
 && pnpm --filter @papyrus/server... run build \
 && pnpm --filter @papyrus/web run build \
 && pnpm install --prod --node-linker=hoisted \
      --config.supportedArchitectures.os=linux \
      --config.supportedArchitectures.cpu=${TARGETARCH} \
      --config.supportedArchitectures.libc=musl \
      --config.confirmModulesPurge=false

# Evidence hygiene: strip TypeScript sources, tests, and build metadata.
RUN find apps packages vendor -type d \( -name src -o -name tests \) -prune -exec rm -rf '{}' + \
 && find apps packages vendor -type f \( -name '*.ts' -o -name '*.map' -o -name '*.d.ts' -o -name 'tsconfig.json' -o -name '*.tsbuildinfo' \) -delete

# ---- runtime: Node + Python + busybox sh ----
FROM cgr.dev/chainguard/wolfi-base AS runtime

# The document toolchain (pypdf/reportlab/pillow) lives in the system Python; the
# entrypoint symlinks it into the data dir for the sandbox.
RUN apk add --no-cache nodejs-24 python-3.12 py3.12-pip busybox ca-certificates-bundle \
 && python3 -m pip install --no-cache-dir --break-system-packages pypdf reportlab pillow \
 && apk del py3.12-pip

ENV NODE_ENV=production \
    PAPYRUS_DATA_DIR=/var/lib/papyrus \
    PAPYRUS_HOST=0.0.0.0 \
    PAPYRUS_PORT=3210 \
    PAPYRUS_TOOLCHAIN_DIR=/opt/papyrus/toolchain

WORKDIR /app

COPY --from=build /src/package.json /src/pnpm-lock.yaml /src/pnpm-workspace.yaml /src/tsconfig.base.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/apps ./apps
COPY --from=build /src/packages ./packages
COPY --from=build /src/vendor ./vendor

COPY deploy/container/entrypoint.mjs /entrypoint.mjs
COPY deploy/container/healthcheck.mjs /healthcheck.mjs

RUN mkdir -p /var/lib/papyrus && chown 65532:65532 /var/lib/papyrus

USER nonroot

VOLUME /var/lib/papyrus

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD ["node", "/healthcheck.mjs"]

ENTRYPOINT ["node", "/entrypoint.mjs"]
