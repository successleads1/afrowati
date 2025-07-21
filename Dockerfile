# Dockerfile
# ───────────────────────────────────────────────────────────────────────────────

# 1) Base image
FROM node:18-alpine

# 2) Chromium deps for Venom/Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ttf-freefont \
    ca-certificates

# 3) Tell Venom to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production

# 4) App directory
WORKDIR /usr/src/app

# 5) Copy manifests & install prod deps only
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# 6) Copy rest of the source
COPY . .

# 7) Expose local‐dev port & the Render one
EXPOSE 3000      # local development
EXPOSE 10000     # Render’s injected $PORT

# 8) Launch
CMD ["node", "server.js"]
