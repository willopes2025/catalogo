FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @aritana/regras build && pnpm --filter @aritana/painel build

FROM nginx:alpine
COPY --from=build /app/apps/painel/dist /usr/share/nginx/html
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
