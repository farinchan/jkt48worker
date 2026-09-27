# JKT48 Stream Auto Recorder

Production-ready, unattended 24/7 Node.js application that monitors the live JKT48 playback endpoint, automatically parses the HLS master playlist, selects the highest resolution video variant (e.g., 1080p60), records with FFmpeg without transcoding (`-c copy`), and uploads finalized recordings to Google Drive using a resumable streaming upload queue with crash recovery and local disk protection.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Features](#2-features)
3. [Architecture](#3-architecture)
4. [System Requirements](#4-system-requirements)
5. [Node.js Installation](#5-nodejs-installation)
6. [FFmpeg Installation](#6-ffmpeg-installation)
7. [Google Cloud Console Setup](#7-google-cloud-console-setup)
8. [Google Drive OAuth Setup](#8-google-drive-oauth-setup)
9. [Environment Variables](#9-environment-variables)
10. [First Run & Quick Start](#10-first-run--quick-start)
11. [Stream Testing](#11-stream-testing)
12. [Google Drive Testing](#12-google-drive-testing)
13. [Recording Behavior & Atomic Files](#13-recording-behavior--atomic-files)
14. [Highest-Resolution Variant Selection](#14-highest-resolution-variant-selection)
15. [Persistent Upload Queue](#15-persistent-upload-queue)
16. [Retry & Backoff Behavior](#16-retry--backoff-behavior)
17. [Crash Recovery](#17-crash-recovery)
18. [Disk Space Protection](#18-disk-space-protection)
19. [Linux & systemd Deployment](#19-linux--systemd-deployment)
20. [Windows Deployment & Service](#20-windows-deployment--service)
21. [Troubleshooting & FAQs](#21-troubleshooting--faqs)
22. [Security Best Practices](#22-security-best-practices)
23. [Usage & Legal Note](#23-usage--legal-note)

---

## 1. Overview

The endpoint `https://your-worker-domain.workers.dev/playback` is dynamic: it is offline when no live broadcast is occurring and returns an HLS master playlist when a stream is live.

Standard tools that blindly feed this URL into FFmpeg often fall back to the first variant or low resolution, and fail when segment URLs end in non-standard extensions like `.css` or `.js`.

This recorder solves this by:
- Inspecting the master playlist dynamically.
- Parsing all stream variants and attribute parameters.
- Choosing the highest resolution available (prioritizing 1080p over 720p/480p/etc.).
- Invoking FFmpeg with streaming reconnect and wildcard segment extension flags.
- Safely managing recorded files, atomic renames, SQLite persistence, and verified Google Drive uploads.

---

## 2. Features

- **24/7 Unattended Monitoring:** Non-aggressive polling with configurable intervals (`POLL_INTERVAL_MS=10000`).
- **Dynamic HLS Master Playlist Parser:** Pairs `#EXT-X-STREAM-INF` variants with their media tags and resolves relative URIs.
- **Highest Resolution Selection:** Sorts variants by height, width, effective bandwidth, and frame rate.
- **Support for Non-Standard Extension Segments:** Employs FFmpeg flags (`-allowed_extensions ALL -allowed_segment_extensions ALL -extension_picky 0 -f hls`) to record CDN variants ending in `.css` or `.js`.
- **Zero-Transcoding Stream Copy:** Uses `-c copy` to record native video/audio streams with minimal CPU overhead.
- **Atomic File Workflow:** Records to `.partial.mp4` and renames to final `.mp4` only upon successful finalization.
- **SQLite Database with Crash Recovery:** Keeps track of all recordings, tracks upload attempts, and restores interrupted recordings on startup.
- **Google Drive Resumable Streaming Upload:** Streams multi-gigabyte recordings directly to Google Drive with verification before deleting local files.
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
                                      ▼
                         ┌──────────────────────────┐
                         │ Google Drive Uploader    │
                         │ (Resumable Stream)       │
                         └────────────┬─────────────┘
                                      │
                               upload verified
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Delete Local Recording   │
                         └──────────────────────────┘
```

---

## 4. System Requirements

- **Operating System:** Linux (Ubuntu 20.04+, Debian 11+, CentOS 8+) or Windows (10/11/Server).
- **Node.js:** v18.15.0 LTS or higher (Node 20+ or 24+ recommended).
- **FFmpeg & FFprobe:** v4.4 or higher (v6+ / v7+ recommended with HLS demuxer support).
- **Disk Space:** Sufficient free space for live stream buffers (recommended >= 50 GB).
- **Google Account:** With Google Drive API enabled and OAuth 2.0 Desktop credentials.

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

## 7. Google Cloud Console Setup

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g., `jkt48-recorder`).
3. Navigate to **APIs & Services** > **Library**.
4. Search for **Google Drive API** and click **Enable**.
5. Navigate to **OAuth consent screen**:
   - Choose **External** (or Internal for Workspace).
   - Fill in the App Name and user support email.
   - Under **Scopes**, add `https://www.googleapis.com/auth/drive.file`.
   - Add your Google account under **Test users**.
6. Navigate to **Credentials** > **Create Credentials** > **OAuth client ID**:
   - Application type: **Desktop app**.
   - Name: `JKT48 Stream Recorder`.
   - Click **Create**.
7. Download the credentials JSON and save it as:
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

## 9. Environment Variables

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
| `CREDENTIALS_DIR` | `./credentials` | Directory for `client_secret.json` and `token.json`. |
| `TIMEZONE` | `Asia/Jakarta` | Timezone for filename timestamps and directories. |
| `FFMPEG_PATH` | `ffmpeg` | Path to FFmpeg executable. |
| `FFPROBE_PATH` | `ffprobe` | Path to FFprobe executable. |
| `MIN_RECORDING_SIZE_BYTES` | `1048576` | Minimum recording size (1MB) to consider valid. |
| `MIN_FREE_DISK_GB` | `20` | Minimum free disk space required to record. |
| `GOOGLE_DRIVE_FOLDER_ID` | `""` | Target Google Drive folder ID (leave blank for root). |
| `GOOGLE_UPLOAD_RETRY_INITIAL_MS` | `10000` | Initial exponential backoff delay (10s). |
| `GOOGLE_UPLOAD_RETRY_MAX_MS` | `600000` | Max backoff delay (10 minutes). |
| `GOOGLE_UPLOAD_MAX_RETRIES` | `0` | Max upload retries (0 = unlimited). |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Max wait time during graceful shutdown. |
| `LOG_LEVEL` | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`). |
| `DRY_RUN` | `false` | When `true`, tests playlist parsing without recording. |

---

## 10. First Run & Quick Start

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
4. Start the service:
   ```bash
   npm start
   ```

---

## 11. Stream Testing

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

## 12. Google Drive Testing

Verify Drive credentials, folder permissions, and end-to-end upload/verification:

```bash
npm run test:drive
```

---

## 13. Recording Behavior & Atomic Files

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

## 14. Highest-Resolution Variant Selection

Variant selection follows strict ordering:
1. **Resolution (Height & Width):** Highest pixel height descending (e.g., 1080p > 720p > 480p).
2. **Explicit Resolution:** Variants with defined resolutions are prioritized over variants without.
3. **Effective Bandwidth:** Higher bitrate wins when resolution is identical.
4. **Frame Rate:** Higher FPS wins (e.g., 60fps > 30fps) when resolution and bandwidth are tied.

---

## 15. Persistent Upload Queue

Uploads run independently from the recording engine in a persistent background worker:
- SQLite persists recording status (`RECORDING`, `FINALIZING`, `PENDING_UPLOAD`, `UPLOADING`, `UPLOADED`, `UPLOAD_FAILED`, `INVALID`).
- Even if Google Drive is temporarily offline, stream recordings continue uninterrupted and queue locally.
- Large files stream using `fs.createReadStream()` and Google Drive resumable upload.
- Local files are deleted **only** after Google Drive returns a valid file ID and metadata is verified.

---

## 16. Retry & Backoff Behavior

Failed uploads enter an exponential backoff schedule:
$$\text{delay} = \min(\text{INITIAL\_MS} \times 2^{\text{attempts}}, \text{MAX\_MS})$$
By default:
- Attempt 1: 10 seconds
- Attempt 2: 20 seconds
- Attempt 3: 40 seconds
- Max backoff: 10 minutes (`600000ms`)
- Max retries: 0 (unlimited retries until Drive recovers)

---

## 17. Crash Recovery

On application startup, `recoverStartupState()` automatically inspects SQLite:
- Stale `UPLOADING` records are re-queued to `PENDING_UPLOAD` if the local file exists.
- Crashed `RECORDING` sessions with existing `.partial.mp4` files are validated and finalized into `PENDING_UPLOAD`.
- Missing or 0-byte files are flagged as `INVALID` with reasons recorded.

---

## 18. Disk Space Protection

Before starting any recording and periodically during polling:
- `fs.statfsSync()` inspects available free gigabytes on the target filesystem.
- If free space is below `MIN_FREE_DISK_GB` (default: 20 GB), recording is skipped and a warning is logged.
- Recorded files are never deleted prematurely to free space.

---

## 19. Linux & systemd Deployment

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

## 20. Windows Deployment & Service

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

## 21. Troubleshooting & FAQs

### Q: Why did FFmpeg fail with "is not in allowed_segment_extensions"?
Some CDNs deliver live HLS segments ending in non-standard extensions like `.css` or `.js`. This application automatically passes `-allowed_extensions ALL -allowed_segment_extensions ALL -extension_picky 0 -f hls` to FFmpeg to bypass this limitation.

### Q: Does Google Drive upload block active recording?
No. Recording and uploading run asynchronously. A 2-hour stream recording can continue while previous recordings are uploading.

### Q: Where are the logs?
Logs are written in JSON Lines format to `logs/app.log` and formatted to stdout in development mode.

### Q: How do I check the recorder status?
Run:
```bash
npm run status
```

---

## 22. Security Best Practices

- `client_secret.json`, `token.json`, and `.env` are listed in `.gitignore` and must never be committed to source control.
- Pino logger includes redaction filters for OAuth tokens and authorization headers.
- FFmpeg is executed using Node.js `spawn()` with an argument array to prevent shell injection vulnerabilities.

---

## 23. Usage & Legal Note

This software is designed solely for archival and personal backup purposes. Ensure you have the right to record and store any stream content in accordance with applicable terms of service and local laws.
