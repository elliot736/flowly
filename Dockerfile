FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --production

FROM node:22-alpine

WORKDIR /app

RUN addgroup -S workflow && adduser -S workflow -G workflow

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

USER workflow

ENV NODE_ENV=production

ENTRYPOINT ["node"]
CMD ["dist/standalone.js"]
