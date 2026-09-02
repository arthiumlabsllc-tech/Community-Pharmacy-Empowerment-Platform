# Stage 1: Build Next.js
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NEXT_PRIVATE_STANDALONE=true
RUN npm run build

# Stage 2: Production
FROM node:18-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/public ./public

# Next.js standalone output (enabled via NEXT_PRIVATE_STANDALONE)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000

CMD ["node", "server.js"]
