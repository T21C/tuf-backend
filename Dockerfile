# Production image - expects pre-built dist folder
FROM node:20-alpine

# Install Chromium and dependencies for Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    mysql-client

# Tell Puppeteer to use installed Chromium instead of downloading
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy pre-built dist folder
COPY dist/ ./dist/

# Copy assets if needed
COPY assets/ ./assets/

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
