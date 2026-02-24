FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json nodemon.json ./
COPY src ./src
COPY tools ./tools
COPY vendor ./vendor

RUN chmod +x /app/tools/youtube-dl.sh \
  && npm run build \
  && npm prune --omit=dev \
  && mkdir -p /app/storage /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV STORAGE_DIR=/app/storage

EXPOSE 3000

CMD ["npm", "start"]
