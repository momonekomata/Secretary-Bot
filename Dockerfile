#   docker build -t secretary-bot .
#   docker run -d --restart unless-stopped --env-file .env -v secretary-bot-data:/data -p 8787:8787 secretary-bot
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
ENV BOT_DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8787
CMD ["npx", "tsx", "src/main.ts"]
