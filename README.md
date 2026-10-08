# JKT48 Stream Auto Recorder

Production-ready, unattended 24/7 Node.js application that monitors the live JKT48 playback endpoint, automatically parses the HLS master playlist, selects the highest resolution video variant (e.g., 1080p60), records with FFmpeg without transcoding (`-c copy`), and automatically uploads finalized recordings to **Google Drive** and **YouTube** using a resumable streaming upload queue with crash recovery and local disk protection.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Features](#2-features)
3. [Architecture](#3-architecture)
4. [System Requirements](#4-system-requirements)
5. [Node.js Installation](#5-nodejs-installation)
6. [FFmpeg Installation](#6-ffmpeg-installation)
7. [Google Cloud Console Setup (Drive + YouTube)](#7-google-cloud-console-setup-drive--youtube)
8. [Google Drive OAuth Setup](#8-google-drive-oauth-setup)
9. [YouTube OAuth & Channel Setup](#9-youtube-oauth--channel-setup)
10. [Environment Variables](#10-environment-variables)
11. [First Run & Quick Start](#11-first-run--quick-start)
12. [Stream Testing](#12-stream-testing)
13. [Google Drive Testing](#13-google-drive-testing)
14. [YouTube Testing](#14-youtube-testing)
15. [Telegram Bot Setup & Testing](#15-telegram-bot-setup--testing)
16. [Recording Behavior & Atomic Files](#16-recording-behavior--atomic-files)
17. [Highest-Resolution Variant Selection](#17-highest-resolution-variant-selection)
18. [Persistent Upload Queue (Dual Platform)](#18-persistent-upload-queue-dual-platform)
19. [Retry & Backoff Behavior](#19-retry--backoff-behavior)
20. [Crash Recovery](#20-crash-recovery)
21. [Disk Space Protection](#21-disk-space-protection)
22. [Linux & systemd Deployment](#22-linux--systemd-deployment)
23. [Windows Deployment & Service](#23-windows-deployment--service)
24. [Docker & Docker Compose Deployment](#24-docker--docker-compose-deployment)
25. [Web Management Dashboard](#25-web-management-dashboard)
26. [Troubleshooting & FAQs](#26-troubleshooting--faqs)
27. [Security Best Practices](#27-security-best-practices)
28. [Usage & Legal Note](#28-usage--legal-note)

---

## 1. Overview

The endpoint `https://your-worker-domain.workers.dev/playback` is dynamic: it is offline when no live broadcast is occurring and returns an HLS master playlist when a stream is live.

Standard tools that blindly feed this URL into FFmpeg often fall back to the first variant or low resolution, and fail when segment URLs end in non-standard extensions like `.css` or `.js`.

This recorder solves this by:
- Inspecting the master playlist dynamically.
- Parsing all stream variants and attribute parameters.
- Choosing the highest resolution available (prioritizing 1080p over 720p/480p/etc.).
- Invoking FFmpeg with streaming reconnect and wildcard segment extension flags.
- Safely managing recorded files, atomic renames, SQLite persistence, and verified uploads to both Google Drive and YouTube.

---

## 2. Features

- **24/7 Unattended Monitoring:** Non-aggressive polling with configurable intervals (`POLL_INTERVAL_MS=10000`).
- **Dynamic HLS Master Playlist Parser:** Pairs `#EXT-X-STREAM-INF` variants with their media tags and resolves relative URIs.
- **Highest Resolution Selection:** Sorts variants by height, width, effective bandwidth, and frame rate.
- **Support for Non-Standard Extension Segments:** Employs FFmpeg flags (`-allowed_extensions ALL -allowed_segment_extensions ALL -extension_picky 0 -f hls`) to record CDN variants ending in `.css` or `.js`.
- **Zero-Transcoding Stream Copy:** Uses `-c copy` to record native video/audio streams with minimal CPU overhead.
- **Atomic File Workflow:** Records to `.partial.mp4` and renames to final `.mp4` only upon successful finalization.
- **SQLite Database with Crash Recovery:** Keeps track of all recordings, tracks upload attempts, and restores interrupted recordings on startup.
- **Google Drive Resumable Streaming Upload:** Streams multi-gigabyte recordings directly to Google Drive.
- **YouTube Data API v3 Auto-Upload:** Automatically uploads recorded live streams to YouTube as unlisted/private/public videos with customizable title templates, descriptions, and tags.
- **Safe Dual Deletion:** Local files are deleted **only** after both Google Drive and YouTube (if enabled) have verified successful uploads.
- **Disk Protection:** Checks available disk space before and during recordings (`MIN_FREE_DISK_GB=20`).
- **Single Instance Enforcement:** SQLite process lock prevents duplicate recorders from running simultaneously.
- **Graceful Shutdown:** Handles `SIGINT` and `SIGTERM` cleanly, finalizing active FFmpeg sessions.

---

## 3. Architecture

```text
                         ┌──────────────────────────┐
                         │   GET /playback          │
                         │   Master HLS Playlist    │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Master Playlist Parser   │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Variant Selector         │
                         │ Highest Resolution       │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ FFmpeg Recorder          │
                         │ Stream Copy (-c copy)    │
                         │ writing .partial.mp4     │
                         └────────────┬─────────────┘
                                      │
                               stream ends
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Atomic Finalization      │
                         │ validate & rename .mp4   │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Persistent Upload Queue  │
                         │ (SQLite Database)        │
                         └────────────┬─────────────┘
                                      │
                       ┌──────────────┴──────────────┐
                       ▼                             ▼
          ┌──────────────────────────┐  ┌──────────────────────────┐
          │  Google Drive Uploader   │  │     YouTube Uploader     │
          │    (Resumable Stream)    │  │    (Resumable Stream)    │
          └────────────┬─────────────┘  └────────────┬─────────────┘
                       │                             │
                 Drive verified               YouTube verified
                       └──────────────┬──────────────┘
                                      │ (both verified)
                                      ▼
                         ┌──────────────────────────┐
                         │  Delete Local Recording  │
                         └──────────────────────────┘
```

---

## 4. System Requirements

- **Operating System:** Linux (Ubuntu 20.04+, Debian 11+, CentOS 8+) or Windows (10/11/Server).
- **Node.js:** v18.15.0 LTS or higher (Node 20+ or 24+ recommended).
- **FFmpeg & FFprobe:** v4.4 or higher (v6+ / v7+ recommended with HLS demuxer support).
- **Disk Space:** Sufficient free space for live stream buffers (recommended >= 50 GB).
- **Google Account:** With Google Drive API and YouTube Data API v3 enabled.

---

## 5. Node.js Installation

### Linux (Ubuntu/Debian)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v # Should display v20.x or higher
```

### Windows
Download and run the official installer from [nodejs.org](https://nodejs.org/).

---

## 6. FFmpeg Installation

### Linux (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install -y ffmpeg
ffmpeg -version
ffprobe -version
```

### Windows
1. Download a prebuilt static build (e.g. from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)).
2. Extract to `C:\ffmpeg`.
3. Add `C:\ffmpeg\bin` to your System `PATH`, or set `FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe` and `FFPROBE_PATH=C:\ffmpeg\bin\ffprobe.exe` in your `.env` file.

---

## 7. Google Cloud Console Setup (Drive + YouTube)

Both Google Drive and YouTube share the same Google Cloud project and `client_secret.json`:

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select your project (e.g., `jkt48-recorder`).
3. Navigate to **APIs & Services** > **Library**:
   - Search for **Google Drive API** and click **Enable**.
   - Search for **YouTube Data API v3** and click **Enable**.
4. Navigate to **OAuth consent screen**:
   - Choose **External** (or Internal for Workspace).
   - Fill in the App Name and user support email.
   - Under **Scopes**, add:
     - `https://www.googleapis.com/auth/drive.file`
     - `https://www.googleapis.com/auth/youtube.upload`
   - Add your Google account email under **Test users**.
5. Navigate to **Credentials** > **Create Credentials** > **OAuth client ID**:
   - Application type: **Desktop app**.
   - Name: `JKT48 Stream Recorder`.
   - Click **Create**.
6. Download the credentials JSON and save it as:
   ```text
   credentials/client_secret.json
   ```

---

## 8. Google Drive OAuth Setup

Run the Drive authorization CLI tool:
```bash
npm run test:drive
```

1. If `credentials/token.json` does not exist, the script prints an authorization URL.
2. Open the URL in your browser, log in, grant permission, and copy the authorization code.
3. Paste the authorization code back into the terminal prompt.
4. The tool saves `credentials/token.json`, tests Drive access, verifies target folders, uploads a tiny test verification file, verifies metadata, and cleans it up.

---

## 9. YouTube OAuth & Channel Setup

Run the YouTube authorization CLI tool:
```bash
npm run test:youtube
```

1. If `credentials/youtube_token.json` does not exist, the script prints the YouTube authorization URL.
2. Open the URL in your browser, select your Google / YouTube channel account, grant upload permissions, and copy the authorization code.
3. Paste the authorization code back into the terminal prompt.
4. The tool saves `credentials/youtube_token.json` and verifies access by fetching and displaying your channel title, custom URL, and subscriber count.
5. In your `.env` file, set:
   ```env
   YOUTUBE_UPLOAD_ENABLED=true
   ```

> [!TIP]
> **YouTube Quota & Privacy:**
> - YouTube Data API provides a default free quota of **10,000 units/day**.
> - Each video upload costs **1,600 units**, allowing up to 6 uploads per day (more than enough for daily JKT48 streams).
> - Keep `YOUTUBE_PRIVACY_STATUS=unlisted` so videos are uploaded securely without immediately broadcasting to public feeds.

---

## 10. Environment Variables

Create a `.env` file based on `.env.example`:

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `production` | Environment mode (`production` or `development`). |
| `STREAM_URL` | `https://your-worker-domain.workers.dev/playback` | Live stream master playlist URL. |
| `POLL_INTERVAL_MS` | `10000` | Stream polling interval in milliseconds. |
| `REQUEST_TIMEOUT_MS` | `10000` | HTTP request timeout for playlist checks. |
| `RECORDINGS_DIR` | `./recordings` | Directory where recorded MP4 files are stored. |
| `DATA_DIR` | `./data` | Directory for SQLite database. |
| `LOG_DIR` | `./logs` | Directory for application logs. |
| `CREDENTIALS_DIR` | `./credentials` | Directory for `client_secret.json`, `drive_token.json`, and `youtube_token.json`. |
| `TIMEZONE` | `Asia/Jakarta` | Timezone for filename timestamps and directories. |
| `FFMPEG_PATH` | `ffmpeg` | Path to FFmpeg executable. |
| `FFPROBE_PATH` | `ffprobe` | Path to FFprobe executable. |
| `MIN_RECORDING_SIZE_BYTES` | `1048576` | Minimum recording size (1MB) to consider valid. |
| `MIN_FREE_DISK_GB` | `20` | Minimum free disk space required to record. |
| `GOOGLE_DRIVE_FOLDER_ID` | `""` | Target Google Drive folder ID (leave blank for root). |
| `GOOGLE_UPLOAD_RETRY_INITIAL_MS` | `10000` | Initial exponential backoff delay (10s). |
| `GOOGLE_UPLOAD_RETRY_MAX_MS` | `600000` | Max backoff delay (10 minutes). |
| `GOOGLE_UPLOAD_MAX_RETRIES` | `0` | Max upload retries (0 = unlimited). |
| `YOUTUBE_UPLOAD_ENABLED` | `false` | Enable automatic uploads to YouTube (`true` or `false`). |
| `YOUTUBE_PRIVACY_STATUS` | `unlisted` | Privacy status (`unlisted`, `private`, or `public`). |
| `YOUTUBE_TITLE_TEMPLATE` | `JKT48 Live Stream - {date}` | Dynamic video title template. |
| `YOUTUBE_DESCRIPTION_TEMPLATE` | `Recorded automatically...` | Dynamic video description template. |
| `YOUTUBE_CATEGORY_ID` | `24` | YouTube Category ID (`24` = Entertainment, `10` = Music). |
| `YOUTUBE_DEFAULT_TAGS` | `JKT48,Live,Stream...` | Comma-separated video tags. |
| `YOUTUBE_MADE_FOR_KIDS` | `false` | YouTube COPPA declaration. |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Max wait time during graceful shutdown. |
| `LOG_LEVEL` | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`). |
| `DRY_RUN` | `false` | When `true`, tests playlist parsing without recording. |
| `WEB_ENABLED` | `true` | Enable built-in web management dashboard (`true` or `false`). |
| `WEB_PORT` | `60021` | HTTP port for web dashboard. |
| `WEB_PASSWORD` | `admin` | Password for web dashboard authentication. |
| `TELEGRAM_BOT_ENABLED` | `false` | Enable live notifications via Telegram Bot (`true` or `false`). |
| `TELEGRAM_BOT_TOKEN` | `""` | Telegram Bot API token from `@BotFather`. |
| `TELEGRAM_CHAT_ID` | `""` | Target Telegram Chat ID or Channel ID to receive alerts. |

---

## 11. First Run & Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run automated unit tests:
   ```bash
   npm test
   ```
3. Test live stream discovery:
   ```bash
   npm run test:stream
   ```
4. Authenticate Drive and/or YouTube:
   ```bash
   npm run test:drive
   npm run test:youtube
   ```
5. Check recorder status:
   ```bash
   npm run status
   ```
6. Start the recorder service 24/7:
   ```bash
   npm start
   ```

---

## 12. Stream Testing

Use `npm run test:stream` to probe the stream without starting a recording:

```bash
npm run test:stream
```

Sample output:
```text
Checking stream endpoint: https://your-worker-domain.workers.dev/playback
--------------------------------------------------
HTTP Status: 200 OK
Content-Type: application/javascript
Stream reachable: YES
Master playlist: YES
Direct media playlist: NO
Variants: 5

Available variants:
- 1920x1080 8109445 bps 60fps [name: 1080p60]
- 1280x720 3422999 bps 60fps [name: 720p60]
- 852x480 1427999 bps 30fps [name: 480p]
- 640x360 630000 bps 30fps [name: 360p]
- 284x160 230000 bps 30fps [name: 160p]

Selected:
1920x1080 (8109445 bps, 60fps)
URI: https://your-worker-domain.workers.dev/live/...
```

---

## 13. Google Drive Testing

Verify Drive credentials, folder permissions, and end-to-end upload/verification:

```bash
npm run test:drive
```

---

## 14. YouTube Testing

Verify YouTube credentials, channel permissions, and upload readiness:

```bash
npm run test:youtube
```

---

## 15. Telegram Bot Setup & Testing

Receive real-time alerts directly in your Telegram chat or channel whenever a stream starts, finishes, or uploads.

### Setup Instructions:
1. **Create a Bot with BotFather:**
   - Open Telegram and message `@BotFather`.
   - Send `/newbot`, follow prompts, and obtain your **HTTP API Token** (e.g. `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`).
2. **Find Your Chat ID:**
   - Message `@userinfobot` on Telegram to get your personal Chat ID.
   - For a Telegram Channel or Group: add the bot as an administrator and use your channel/group ID (e.g. `-1001234567890`).
3. **Configure in `.env`:**
   ```env
   TELEGRAM_BOT_ENABLED=true
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
   TELEGRAM_CHAT_ID=your_chat_id
   ```
4. **Test Delivery:**
   ```bash
   npm run test:telegram
   ```
   *(Or click **Test Telegram Alert** in the Web Management Dashboard).*

### Events Notified:
- 🚀 **Worker Online & Active:** Sent on startup showing host, PID, environment, web dashboard port, Google Drive & YouTube status, and available disk space.
- 🛑 **Worker Stopped / Offline:** Sent on graceful shutdown or crash showing reason and uptime duration.
- 🔄 **Crash Recovery:** Sent on startup if unfinished sessions from a previous run or reboot are recovered.
- 🔴 **Stream Online & Recording Started:** Resolution, FPS, bandwidth, and filename.
- ⏹ **Recording Finalized:** Total duration, video file size, and upload queue status.
- ❌ **Recording Interrupted / Error:** Detailed error reasons if FFmpeg fails or file size is invalid.
- ☁️ **Google Drive Upload:** Direct view link when uploaded, or failure reason and attempt count.
- 📺 **YouTube Upload:** Direct video watch link when uploaded, or failure reason.
- ✅ **Uploads Complete:** When both Drive and YouTube are verified and local file is pruned.
- 🚨 **Low Disk Space:** Alert when free storage drops below `MIN_FREE_DISK_GB`.
- 📊 **Status Report / Heartbeat:** Triggered on-demand from the Web Dashboard or periodically via `TELEGRAM_HEARTBEAT_INTERVAL_MINUTES`.

---

## 16. Recording Behavior & Atomic Files

- **File Naming:** Files are named using the recording start time formatted in the configured timezone (`Asia/Jakarta`):
  `YYYY-MM-DD_HH-mm-ss.mp4` (e.g., `2026-09-27_21-14-26.mp4`).
- **Directory Hierarchy:** Stored organized by date:
  `recordings/2026/09/27/2026-09-27_21-14-26.mp4`.
- **Atomic Writing:** While FFmpeg is actively recording, the file is named `.partial.mp4`.
- **Finalization:** Once FFmpeg exits:
  1. Size is verified against `MIN_RECORDING_SIZE_BYTES`.
  2. The file is atomically renamed from `.partial.mp4` to `.mp4`.
  3. Media metadata and duration are probed with FFprobe.
  4. Database status transitions to `PENDING_UPLOAD`.

---

## 17. Highest-Resolution Variant Selection

Variant selection follows strict ordering:
1. **Resolution (Height & Width):** Highest pixel height descending (e.g., 1080p > 720p > 480p).
2. **Explicit Resolution:** Variants with defined resolutions are prioritized over variants without.
3. **Effective Bandwidth:** Higher bitrate wins when resolution is identical.
4. **Frame Rate:** Higher FPS wins (e.g., 60fps > 30fps) when resolution and bandwidth are tied.

---

## 18. Persistent Upload Queue (Dual Platform)

Uploads run independently from the recording engine in a persistent background worker:
- SQLite persists separate recording statuses (`status` for Drive, `youtube_status` for YouTube).
- Even if Google Drive or YouTube is temporarily offline or quota-limited, recordings continue uninterrupted and queue locally.
- Large files stream using `fs.createReadStream()` and Google / YouTube resumable upload.
- Local files are deleted **only** after both destinations have returned valid IDs and verified metadata.

---

## 19. Retry & Backoff Behavior

Failed uploads enter an exponential backoff schedule:
$$\text{delay} = \min(\text{INITIAL\_MS} \times 2^{\text{attempts}}, \text{MAX\_MS})$$
By default:
- Attempt 1: 10 seconds
- Attempt 2: 20 seconds
- Attempt 3: 40 seconds
- Max backoff: 10 minutes (`600000ms`)
- Max retries: 0 (unlimited retries until destination recovers)

---

## 20. Crash Recovery

On application startup, `recoverStartupState()` automatically inspects SQLite:
- Stale `UPLOADING` records in Drive or YouTube are re-queued to `PENDING_UPLOAD` if the local file exists.
- Crashed `RECORDING` sessions with existing `.partial.mp4` files are validated and finalized into `PENDING_UPLOAD`.
- Missing or 0-byte files are flagged as `INVALID` with reasons recorded.

---

## 21. Disk Space Protection

Before starting any recording and periodically during polling:
- `fs.statfsSync()` inspects available free gigabytes on the target filesystem.
- If free space is below `MIN_FREE_DISK_GB` (default: 20 GB), recording is skipped and a warning is logged.
- Recorded files are never deleted prematurely to free space.

---

## 22. Linux & systemd Deployment

### Step 1: Create dedicated user & copy files
```bash
sudo useradd -r -s /bin/false -d /opt/jkt48-stream-recorder jkt48-recorder
sudo mkdir -p /opt/jkt48-stream-recorder
sudo cp -r . /opt/jkt48-stream-recorder/
sudo chown -R jkt48-recorder:jkt48-recorder /opt/jkt48-stream-recorder
```

### Step 2: Create systemd service
Create `/etc/systemd/system/jkt48-recorder.service`:

```ini
[Unit]
Description=JKT48 Stream Auto Recorder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=jkt48-recorder
Group=jkt48-recorder
WorkingDirectory=/opt/jkt48-stream-recorder
ExecStart=/usr/bin/node /opt/jkt48-stream-recorder/src/index.js
Restart=always
RestartSec=10
NoNewPrivileges=true
KillMode=mixed
TimeoutStopSec=35

[Install]
WantedBy=multi-user.target
```

### Step 3: Enable and start service
```bash
sudo systemctl daemon-reload
sudo systemctl enable jkt48-recorder
sudo systemctl start jkt48-recorder
sudo systemctl status jkt48-recorder
```

---

## 23. Windows Deployment & Service

To run as a background service on Windows:
1. Use **PM2** or **NSSM (Non-Sucking Service Manager)**:
   ```powershell
   npm install -g pm2
   pm2 start src/index.js --name jkt48-recorder
   pm2 save
   pm2 startup
   ```
2. Or create a scheduled task on Windows Task Scheduler configured to run at system startup with highest privileges.

---

## 24. Docker & Docker Compose Deployment

The project includes an optimized `Dockerfile` and `docker-compose.yml` equipped with:
- **Debian Bookworm & Node.js 20 LTS**
- **FFmpeg, tzdata, ca-certificates**
- **`tini` init system:** Properly handles PID 1 signal forwarding (`SIGTERM`/`SIGINT`) to FFmpeg and Node.js without leaving zombie processes.
- **`stop_grace_period: 35s`:** Gives the recorder up to 35 seconds to cleanly finalize and remux any active stream recording before container shutdown.
- **Persistent Bind Mounts:** Persists all recordings, SQLite database, logs, and OAuth tokens on the host filesystem.

### Quick Start with Docker Compose

1. **Configure Environment:**
   Ensure `.env` exists in the project root:
   ```bash
   cp .env.example .env
   # Edit .env as needed
   ```

2. **Place OAuth Credentials:**
   Put your `client_secret.json` into the `credentials/` folder:
   ```text
   credentials/client_secret.json
   ```

3. **Authenticate Google Drive & YouTube (Interactive):**
   Run the CLI tools inside temporary containers to perform the one-time browser OAuth flow:
   ```bash
   # Authenticate Google Drive
   docker compose run --rm recorder npm run test:drive

   # Authenticate YouTube (if enabled)
   docker compose run --rm recorder npm run test:youtube
   ```

4. **Start the Recorder in the Background:**
   ```bash
   docker compose up -d --build
   ```

5. **View Live Application Logs:**
   ```bash
   docker compose logs -f recorder
   # or directly via container name:
   docker logs -f worker-stream-recorder
   ```

6. **Check Recorder Status:**
   ```bash
   docker compose run --rm recorder npm run status
   ```

7. **Test Stream Reachability inside Docker:**
   ```bash
   docker compose run --rm recorder npm run test:stream
   ```

8. **Stop Gracefully:**
   ```bash
   docker compose down
   ```
   *(Docker will send `SIGTERM` and allow up to 35 seconds for active recordings to cleanly close and save).*

---

## 25. Web Management Dashboard

The application includes a built-in, lightweight web management page with pure plain HTML (zero external frontend frameworks, minimal CPU/memory footprint, perfect for Raspberry Pi and headless servers).

### Features:
- **System Overview:** Live stream status, active recording indicator, available disk space, pending upload count, and uptime.
- **Recordings Management:** View all recordings with quick status filters (`All`, `Pending`, `Uploaded`, `Failed`, `Invalid`).
- **Interactive Actions:**
  - **Requeue Upload:** Reset failed or interrupted uploads back to `PENDING_UPLOAD`.
  - **Mark Done:** Manually mark recordings as uploaded.
  - **Delete:** Delete recording metadata, with an option (`del file`) to also delete the local video file on disk.
  - **Trigger Upload Worker:** Force the upload worker to process pending items immediately.
  - **Recover / Sync State:** Check and recover stale or interrupted files on disk.
  - **Test Telegram Alert:** Send an immediate test notification to your configured Telegram chat.
- **Password Authentication:** Protected with a simple password configured directly in `.env`.

### Accessing the Dashboard:
1. Ensure `.env` has:
   ```env
   WEB_ENABLED=true
   WEB_PORT=60021
   WEB_PASSWORD=admin
   ```
2. Open your browser:
   ```text
   http://localhost:60021
   ```
   *(Or `http://<raspberry-pi-ip>:60021` if running remotely).*
3. Enter your configured password to access the management interface.

---

## 26. Troubleshooting & FAQs

### Q: Why did FFmpeg fail with "is not in allowed_segment_extensions"?
Some CDNs deliver live HLS segments ending in non-standard extensions like `.css` or `.js`. This application automatically passes `-allowed_extensions ALL -allowed_segment_extensions ALL -extension_picky 0 -f hls` to FFmpeg to bypass this limitation.

### Q: Does uploading to Drive or YouTube block active recording?
No. Recording and uploading run asynchronously. A multi-hour stream recording can continue while previous recordings are uploading.

### Q: What happens if YouTube quota is exceeded?
The worker detects quota exhaustion (`quotaExceeded`), keeps the local video safely, and marks status as `UPLOAD_FAILED`. It retries on the next day when quota resets.

### Q: Where are the logs?
Logs are written in JSON Lines format to `logs/app.log` and formatted to stdout in development mode.

### Q: How do I check the recorder status?
Run:
```bash
npm run status
```
Or open the web management dashboard at `http://localhost:60021`.

---

## 27. Security Best Practices

- `client_secret.json`, `drive_token.json`, `youtube_token.json`, and `.env` are listed in `.gitignore` and must never be committed to source control.
- Pino logger includes redaction filters for OAuth tokens and authorization headers.
- FFmpeg is executed using Node.js `spawn()` with an argument array to prevent shell injection vulnerabilities.
- Web dashboard uses timing-safe password comparison and HTTP-only session cookies.

---

## 28. Usage & Legal Note

This software is designed solely for archival and personal backup purposes. Ensure you have the right to record and store any stream content in accordance with applicable terms of service and local laws.
