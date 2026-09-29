# One image for both the HTTP API and the background worker; docker-compose.yml selects the entrypoint.
# Build context is the repository root:  docker build -f apps/api/Dockerfile .

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter "@sgm/api..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @sgm/api build \
    && pnpm --filter @sgm/api deploy --legacy --prod /out

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./package.json
USER node
EXPOSE 4000 4001
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]
