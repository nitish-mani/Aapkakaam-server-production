# ---- Build stage --------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install build tools only if needed by native modules.
RUN apk add --no-cache python3 make g++

# Install prod deps first for layer caching.
COPY package.json yarn.lock* package-lock.json* ./
RUN if [ -f yarn.lock ]; then \
      yarn install --frozen-lockfile --production; \
    else \
      npm ci --omit=dev; \
    fi

# ---- Runtime stage ------------------------------------------------------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_LOGLEVEL=warn

# Drop root — run as the non-root `node` user shipped with the image.
WORKDIR /app

# Bring in node_modules from the builder.
COPY --from=builder /app/node_modules ./node_modules

# Copy application source (respects .dockerignore).
COPY . .

# Ensure logs directory exists and is writable by `node`.
RUN mkdir -p logs && chown -R node:node /app

USER node

EXPOSE 3000

# Basic container health probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "index.js"]
