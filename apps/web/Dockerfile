# Next.js standalone server. Build context is the repository root:  docker build -f apps/web/Dockerfile .

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter "@sgm/web..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# next.config.ts reads WEB_BASE_URL at build time for serverActions.allowedOrigins (baked into the server).
ARG WEB_BASE_URL=http://localhost:3000
ENV WEB_BASE_URL=${WEB_BASE_URL}
RUN pnpm --filter @sgm/web build

FROM node:24-slim
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
