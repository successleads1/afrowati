# Use Node 18 on Alpine
FROM node:18-alpine

# Install system deps for Chromium
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ttf-freefont \
    ca-certificates

# Tell Puppeteer/Venom to use the system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production

# Create app directory
WORKDIR /usr/src/app

# Copy package manifests & install prod deps
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# Copy application source
COPY . .

# Expose port your app listens on
EXPOSE 3000

# Start your server
CMD ["node", "server.js"]
