# syntax=docker/dockerfile:1

# ---- build: compile TypeScript ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- deps: production dependencies only (includes video.js + bootstrap, served locally: 
# no CDN needed on a LAN) ----
FROM node:22-bookworm-slim AS deps
# toolchain only as a fallback if better-sqlite3 has to compile; it never reaches the final image
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
# ffmpeg powers track listing, embedded subtitles, audio-track switching and the compatibility stream.
# Build with --build-arg WITH_FFMPEG=0 for a smaller image (basic playback only).
ARG WITH_FFMPEG=1
RUN if [ "$WITH_FFMPEG" = "1" ]; then apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*; fi
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    SQLITE_PATH=/data/data.sqlite \
    MEDIA_ROOTS=/media
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json ./
RUN mkdir -p /data /media && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/server.js"]
