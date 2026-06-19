FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
RUN addgroup -S meadow && adduser -S meadow -G meadow
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /home/container && chown meadow:meadow /home/container /app
USER meadow
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
