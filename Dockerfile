FROM node:24-bookworm-slim

# chromium: for pages that need a real browser. python3/make/g++: fallback build for the SQLite module.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NO_OPEN=1 \
    DOTENV_CONFIG_PATH=/app/data/.env \
    AGENT_CONFIG=/app/data/agent.yaml

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Mount a persistent volume at /app/data: it holds the database, settings and saved keys.
CMD ["npx", "tsx", "src/index.ts"]
