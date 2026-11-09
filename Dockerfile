# Multi-arch image (amd64 for Intel/AMD NAS, arm64 for ARM NAS / Raspberry Pi), built by
# .github/workflows/docker.yml and published to ghcr.io. To build it yourself:
#   docker build -t secretary-bot .
FROM node:22-slim
# ffmpeg converts LINE voice messages for Gemini and encodes spoken replies.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
ARG BOT_VERSION=dev
# Everything the bot keeps (store.json, token.json, credentials.json, backups/, optional .env)
# lives in /data: mount a volume there or it is lost when the container is replaced.
ENV BOT_DATA_DIR=/data NODE_ENV=production BOT_VERSION=$BOT_VERSION
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/main.ts"]
