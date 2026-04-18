# Production image - expects pre-built dist folder
FROM node:20-alpine

# Install Chromium + Puppeteer deps, and 7-Zip (required by archiveService for
# .zip / .rar / .7z / .tar / .tar.gz extraction and pack-zip creation).
# Alpine's `7zip` ships the upstream 22+ build as `7zz`, which has native RAR5
# support. archiveService calls the binary as `7z`, so we symlink it. `p7zip` is
# kept as a fallback codec source for older RAR archives.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    mysql-client \
    7zip \
    p7zip \
    && (command -v 7z >/dev/null 2>&1 || ln -sf "$(command -v 7zz)" /usr/local/bin/7z)

# Tell Puppeteer to use installed Chromium instead of downloading
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy pre-built dist folder
COPY dist/ ./dist/

# Create directories for runtime data
RUN mkdir -p uploads cache backups logs

# Set environment
ENV NODE_ENV=production

# Expose the default port
EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/health || exit 1

# Run the server
CMD ["node", "--max-old-space-size=512", "dist/app.js"]
