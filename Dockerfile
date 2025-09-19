# syntax=docker/dockerfile:1

FROM node:20 AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY templates ./templates

RUN npm run build
RUN npm prune --omit=dev

FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5103

COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/templates ./templates

RUN mkdir -p data workspace \
  && chown -R node:node /app

VOLUME ["/app/data", "/app/workspace"]

EXPOSE 5103

USER node

CMD ["node", "dist/server/index.js"]
