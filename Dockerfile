# syntax=docker/dockerfile:1

FROM oven/bun:1.3.1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN bun run build

FROM oven/bun:1.3.1 AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/data/attestbook.sqlite
WORKDIR /app
COPY --from=build --chown=bun:bun /app/dist ./dist
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT ?? '3000') + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", "dist/server.js"]
