FROM node:20-bookworm-slim

# Install system dependencies: FFmpeg, tzdata, ca-certificates, and tini
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    tzdata \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Set default timezone
ENV TZ=Asia/Jakarta
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package*.json ./

# Install production dependencies cleanly
RUN npm ci --omit=dev

# Copy application source code
COPY src/ ./src/

# Ensure runtime mount directories exist
RUN mkdir -p /app/recordings /app/data /app/logs /app/credentials

# Set production environment variables
ENV NODE_ENV=production \
    FFMPEG_PATH=ffmpeg \
    FFPROBE_PATH=ffprobe \
    RECORDINGS_DIR=/app/recordings \
    DATA_DIR=/app/data \
    LOG_DIR=/app/logs \
    CREDENTIALS_DIR=/app/credentials

# Use tini as PID 1 to properly forward SIGTERM/SIGINT to Node and FFmpeg child processes
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["node", "src/index.js"]
