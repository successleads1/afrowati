# ───────────────────────────────
# Dockerfile
# ───────────────────────────────

# 1. Use Debian slim instead of Alpine
FROM node:18-slim

# 2. Install Chromium & fonts & other deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-noto-color-emoji \
      # these two help avoid sandboxing errors:
      libnss3 \
      libatk1.0-0 \
 && rm -rf /var/lib/apt/lists/*

# 3. Tell Puppeteer/Venom to skip downloading Chromium
#    and where to find the system one we just installed.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

# 4. Create & cd into our app
WORKDIR /usr/src/app

# 5. Copy only package manifests, install prod deps
COPY package*.json ./
RUN npm ci --omit=dev

# 6. Copy the rest of the source
COPY . .

# 7. Expose nothing (Render will inject $PORT)
#    But for clarity:
EXPOSE 3000

# 8. Start your server
CMD ["node", "server.js"]
