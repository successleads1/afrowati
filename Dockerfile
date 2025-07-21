# 1) Use Debian‑slim (better Chrome compatibility than Alpine)
FROM node:18-bullseye-slim

# 2) Install Chromium & its deps
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxfixes3 \
    libxi6 \
    libxtst6 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgtk-3-0 \
    libxrandr2 \
    libxss1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libstdc++6 \
    lsb-release \
    xdg-utils \
  --no-install-recommends && \
  rm -rf /var/lib/apt/lists/*

# 3) Tell Puppeteer/Venom to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

# 4) Create & switch to app dir
WORKDIR /usr/src/app

# 5) Install only prod deps
COPY package*.json ./
RUN npm ci --omit=dev

# 6) Copy source
COPY . .

# 7) Expose local & Render port
EXPOSE 3000
EXPOSE 10000

# 8) Start
CMD ["node", "server.js"]
