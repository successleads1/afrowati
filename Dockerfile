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
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production

# Create working directory
WORKDIR /usr/src/app

# Copy package manifests & install production deps
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# Copy application source
COPY . .

# Expose both your local‑dev port and Render’s injected port
EXPOSE 3000
EXPOSE 10000

# Start the server
CMD ["node", "server.js"]
