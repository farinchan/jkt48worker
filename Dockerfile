# ==========================================
# Stage 1: Build Dependencies
# ==========================================
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install build tools in case native C++ compilation is required (e.g. better-sqlite3 on aarch64)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# ==========================================
# Stage 2: Production Runtime
# ==========================================
FROM node:20-bookworm-slim

# Install runtime dependencies: FFmpeg, tzdata, ca-certificates, and tini
# All are natively available on linux/amd64 and linux/arm64 (aarch64)
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

# Copy production node_modules from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
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
