FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @aritana/regras build && pnpm --filter @aritana/api build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY --from=build /app .
WORKDIR /app/apps/api
ENV NODE_ENV=production
EXPOSE 3000
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/main.js"]
