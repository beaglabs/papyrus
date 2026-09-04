# syntax=docker/dockerfile:1.7
FROM reg.mini.dev/node-fips:v24.19.0-dev@sha256:c92b0186c8c2b1e6f10e0b7b401348a47844551744cd1890f7b60fce46d5cae5 AS build

WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY acp-runtime/package.json acp-runtime/package.json
COPY contracts/package.json contracts/package.json
RUN corepack pnpm install --frozen-lockfile

COPY apps/server apps/server
COPY acp-runtime acp-runtime
COPY contracts contracts
RUN corepack pnpm --filter @papyrus/server... run build \
 && corepack pnpm --filter @papyrus/server --prod deploy --legacy /out \
 && rm -rf /out/src /out/tests /out/scripts /out/tsconfig.json \
 && find /out/node_modules/.pnpm -type d \( -name src -o -name tests \) -prune -exec rm -rf '{}' + \
 && find /out -type f \( -name '*.map' -o -name '*.d.ts' -o -name 'tsconfig.json' \) -delete

FROM reg.mini.dev/node-fips:v24.19.0@sha256:f223e63d9852e4768e0a5ed9604c72ff556cc1be1517893613066d03459b713f

ENV NODE_ENV=production \
    PAPYRUS_DATA_DIR=/var/lib/papyrus
WORKDIR /app
COPY --from=build --chown=1000:1000 /out ./

USER 1000
EXPOSE 3210 3220
ENTRYPOINT ["node", "dist/container.js"]
