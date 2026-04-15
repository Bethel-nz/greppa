FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS release
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /data

ENV NODE_ENV=production
ENV MEMORY_PATH=/data/chatbot-memory.mv2

EXPOSE 3009

CMD ["bun", "run", "start"]
