# node:22-slim = Debian/glibc — required by workerd (workerd is a glibc binary, won't run on Alpine/musl)
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    wget \
  && rm -rf /var/lib/apt/lists/*

# Create non-root user WITH a home directory so wrangler can write ~/.config
RUN groupadd -r wabizz && useradd -r -g wabizz -m -d /home/wabizz wabizz

WORKDIR /app

# Install deps as root so npm can write to node_modules
# --include=optional ensures platform-specific binaries (workerd) are installed
COPY package*.json ./
RUN npm ci --include=optional

# Copy full source
COPY . .

# Create writable dirs, fix ownership
RUN mkdir -p .wrangler logs && chown -R wabizz:wabizz /app /home/wabizz

USER wabizz

HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/public/health || exit 1

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]

CMD ["sh", "-c", "npm run build && node .output/server/index.mjs"]
