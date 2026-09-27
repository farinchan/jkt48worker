# JKT48 Stream Auto Recorder — Agentic AI Implementation Specification

## 1. Project Overview

Build a production-ready **Node.js application** that continuously monitors:

```text
https://your-worker-domain.workers.dev/playback
```

The endpoint may be offline at some times and active at other times.

When active, it returns a **master HLS playlist** containing multiple video variants.

The application must:

1. Continuously monitor `/playback`.
2. Detect whether the stream is active.
3. Parse the returned master HLS playlist.
4. Discover all available video variants.
5. Automatically select the **highest available resolution**.
6. Use bandwidth as a secondary criterion when appropriate.
7. Record the selected variant using FFmpeg.
8. Detect stream termination/failure.
9. Finalize the recording safely.
10. Queue the recording for Google Drive upload.
11. Upload large files using a streaming/resumable approach.
12. Verify the upload.
13. Delete the local recording only after successful verification.
14. Continue monitoring for the next stream session.
15. Recover pending recordings after application restart.
16. Operate unattended 24/7.

---

# 2. Technology Stack

Required:

- Node.js LTS
- JavaScript
- FFmpeg
- FFprobe
- Google Drive API
- Google OAuth 2.0
- SQLite or another reliable persistent local database

Recommended packages:

- `googleapis`
- `dotenv`
- `better-sqlite3`
- `pino`

The application must **not require Python**.

---

# 3. Architecture

```text
                         ┌──────────────────────────┐
                         │ /playback                │
                         │ Master HLS Playlist      │
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
                         │ Selected Variant URL     │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ FFmpeg Recorder          │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Finalized Recording      │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Persistent Upload Queue  │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Google Drive Uploader    │
                         └────────────┬─────────────┘
                                      │
                              upload verified
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Delete Local File        │
                         └──────────────────────────┘
```

Keep **stream capture** and **upload** independent.

Google Drive being unavailable must never stop recording.

---

# 4. Critical HLS Behavior

The `/playback` endpoint returns a **master HLS playlist**, not necessarily the final media playlist.

Example:

```m3u8
#EXTM3U

#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="160p30",NAME="160p",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=230000,RESOLUTION=284x160,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="160p30",FRAME-RATE=30.000
https://.../live/...js

#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=8154731,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000
https://.../live/...js

#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3422999,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000
https://.../live/...js
```

Therefore the implementation must **not simply pass `/playback` to FFmpeg and assume the desired quality is selected**.

Correct flow:

```text
GET /playback
      ↓
Master M3U8
      ↓
Parse #EXT-X-STREAM-INF
      ↓
Discover all variants
      ↓
Select highest resolution
      ↓
Use selected variant URL
      ↓
FFmpeg
```

---

# 5. Dynamic Variant URLs

Do **not** hard-code the long variant URLs.

The URLs may contain dynamic/session-specific tokens.

Always fetch the current master playlist:

```text
/playback
```

then select the current variant.

Do not:

- strip query parameters
- modify tokenized paths
- cache URLs indefinitely
- assume a fixed URL for 1080p

A new recording session must perform quality selection again.

---

# 6. URL Extension Must Not Be Trusted

A selected variant URL may end in:

```text
.js
```

even though the response is an HLS playlist.

Do not reject it because it does not end in:

```text
.m3u8
```

Treat the URI as an opaque HLS URL and inspect the response/behavior.

---

# 7. Master Playlist Parser

Create a dedicated module, for example:

```text
src/stream/masterPlaylist.js
```

The parser must:

- recognize `#EXTM3U`
- recognize `#EXT-X-STREAM-INF`
- pair each `#EXT-X-STREAM-INF` with its following URI
- parse attributes correctly
- support quoted attribute values
- support different attribute ordering
- support optional attributes
- support absolute URLs
- support relative URLs
- handle CRLF and LF line endings

Do **not** implement attributes with a naive:

```js
line.split(',')
```

because commas can occur inside quoted values.

Use a maintained parser library or implement a small robust attribute-list tokenizer.

---

# 8. Variant Data Model

Represent variants approximately as:

```js
{
  uri: "https://...",
  width: 1920,
  height: 1080,
  bandwidth: 8154731,
  averageBandwidth: null,
  frameRate: 60,
  codecs: "avc1.64002A,mp4a.40.2",
  videoGroup: "chunked",
  name: "1080p60"
}
```

Optional fields may be `null`.

---

# 9. Variant Selection

The primary criterion is **resolution**.

Given:

```text
1080p → 1920x1080
720p  → 1280x720
480p  → 852x480
360p  → 640x360
160p  → 284x160
```

select:

```text
1920x1080
```

Do not select merely by playlist order.

Do not select merely by bandwidth.

Recommended comparison:

1. height descending
2. width descending
3. effective bandwidth descending
4. frame rate descending

Effective bandwidth:

```js
variant.averageBandwidth ?? variant.bandwidth ?? 0
```

Example:

```js
variants.sort((a, b) => {
  if ((b.height ?? 0) !== (a.height ?? 0)) {
    return (b.height ?? 0) - (a.height ?? 0);
  }

  if ((b.width ?? 0) !== (a.width ?? 0)) {
    return (b.width ?? 0) - (a.width ?? 0);
  }

  const bwA = a.averageBandwidth ?? a.bandwidth ?? 0;
  const bwB = b.averageBandwidth ?? b.bandwidth ?? 0;

  if (bwB !== bwA) {
    return bwB - bwA;
  }

  return (b.frameRate ?? 0) - (a.frameRate ?? 0);
});
```

The exact implementation may differ, but the rule must remain:

> **Resolution is the primary selection criterion.**

---

# 10. Relative URL Resolution

If the playlist contains:

```text
/live/video.m3u8
```

resolve it against the master URL:

```js
new URL(uri, masterUrl).href
```

Do not manually concatenate strings.

---

# 11. Missing Resolution

If a variant does not have `RESOLUTION`:

- prefer variants with explicit resolution
- use bandwidth/frame rate only as fallback
- do not automatically assume missing resolution is highest quality

---

# 12. Direct Media Playlist Fallback

The expected `/playback` response is a master playlist.

However, if no `#EXT-X-STREAM-INF` entries exist but the response contains:

```text
#EXTINF
```

it may be a direct media playlist.

In that case, the application may use the response URL directly as the FFmpeg input.

Log:

```text
Direct media playlist detected
```

Quality selection is not applicable in this case.

---

# 13. Stream Monitoring

Default:

```env
POLL_INTERVAL_MS=10000
REQUEST_TIMEOUT_MS=10000
```

When not recording:

```text
GET /playback
→ parse
→ determine availability
→ wait
→ repeat
```

Do not poll aggressively.

HTTP 404/500/timeout should be handled as normal transient conditions.

---

# 14. Stream Availability

HTTP 200 alone does not mean the stream is active.

Verify:

1. HTTP status
2. HLS content
3. `#EXTM3U`
4. valid master variants or direct media playlist
5. usable URI

If no usable playlist is found:

```text
OFFLINE
```

or an appropriate transient state.

Do not crash the application.

---

# 15. State Machine

Recommended states:

```text
OFFLINE
CHECKING
ONLINE
RECORDING
FINALIZING
PENDING_UPLOAD
UPLOADING
ERROR
```

Typical flow:

```text
OFFLINE
   ↓
CHECKING
   ↓
ONLINE
   ↓
RECORDING
   ↓
FINALIZING
   ↓
PENDING_UPLOAD
   ↓
UPLOADING
   ↓
OFFLINE
```

---

# 16. Recording Start

When the stream becomes active:

1. Fetch master playlist.
2. Parse variants.
3. Select highest resolution.
4. Resolve selected URL.
5. Check disk space.
6. Start FFmpeg.
7. Persist recording metadata.
8. Mark recording as `RECORDING`.

Store at least:

```text
started_at
source URL
resolution
bandwidth
frame rate
output path
status
```

---

# 17. Do Not Restart Recording for Minor Playlist Changes

Once recording starts, do not repeatedly restart FFmpeg simply because the master playlist changes.

For normal transient changes:

- let FFmpeg continue
- use reconnect options where supported
- treat FFmpeg termination as the primary recording-end signal

If FFmpeg definitively exits:

```text
finalize current recording
→ queue upload
→ return to monitoring
```

If the stream later returns:

```text
fetch master again
→ select current highest quality
→ start a new recording
```

---

# 18. FFmpeg Invocation

Use Node.js `spawn()`.

Do not use shell command strings.

Bad:

```js
exec(`ffmpeg -i ${url} output.mp4`);
```

Good:

```js
spawn(ffmpegPath, [
  "-i",
  url,
  "-c",
  "copy",
  outputPath
]);
```

This avoids shell injection and quoting problems.

---

# 19. FFmpeg Configuration

Prefer stream copy:

```text
-c copy
```

because:

- no transcoding
- low CPU usage
- preserves source quality
- suitable for server recording

Do not transcode unless necessary.

Potential reconnect options:

```text
-reconnect 1
-reconnect_streamed 1
-reconnect_at_eof 1
-reconnect_delay_max 10
```

The agent must verify that the installed FFmpeg supports the options before using them.

---

# 20. Output Container

Preferred output:

```text
.mp4
```

Ensure the selected HLS codecs are compatible.

If necessary, use remuxing rather than transcoding.

Do not transcode simply to solve a container issue.

---

# 21. Atomic Recording Files

Never upload an actively-written file.

Use:

```text
recording.partial.mp4
```

while FFmpeg is running.

After FFmpeg exits:

```text
finalize/remux if needed
        ↓
rename to final .mp4
        ↓
validate
        ↓
PENDING_UPLOAD
```

Only finalized files enter the upload queue.

---

# 22. File Naming

Use:

```text
YYYY-MM-DD_HH-mm-ss.mp4
```

Example:

```text
2026-09-27_20-15-03.mp4
```

Use:

```env
TIMEZONE=Asia/Jakarta
```

The timestamp should represent the recording start time.

---

# 23. Directory Structure

Recommended:

```text
recordings/
└── 2026/
    └── 09/
        └── 27/
            ├── 2026-09-27_20-15-03.mp4
            └── 2026-09-27_22-41-10.mp4
```

Configurable:

```env
RECORDINGS_DIR=./recordings
```

---

# 24. SQLite Persistence

Use SQLite for reliable recovery.

Suggested table:

```sql
CREATE TABLE recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_seconds INTEGER,
    width INTEGER,
    height INTEGER,
    bandwidth INTEGER,
    frame_rate REAL,
    source_url TEXT,
    status TEXT NOT NULL,
    file_size INTEGER,
    drive_file_id TEXT,
    upload_attempts INTEGER NOT NULL DEFAULT 0,
    last_upload_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

The agent may adjust the schema if required.

Use migrations and a schema version.

---

# 25. Recording Statuses

Recommended:

```text
RECORDING
FINALIZING
PENDING_UPLOAD
UPLOADING
UPLOADED
UPLOAD_FAILED
INVALID
```

Normal flow:

```text
RECORDING
→ FINALIZING
→ PENDING_UPLOAD
→ UPLOADING
→ UPLOADED
```

Failed upload:

```text
PENDING_UPLOAD
→ UPLOADING
→ UPLOAD_FAILED
→ PENDING_UPLOAD
```

---

# 26. File Validation

Before queueing an upload:

```text
file exists
AND
file size > MIN_RECORDING_SIZE_BYTES
```

Example:

```env
MIN_RECORDING_SIZE_BYTES=1048576
```

Optionally validate duration using FFprobe.

Do not silently discard invalid files.

---

# 27. Google Drive

Use the official Google Drive API.

Use OAuth 2.0.

Recommended scope:

```text
https://www.googleapis.com/auth/drive.file
```

Use a broader scope only when necessary.

---

# 28. Google Drive Credentials

Recommended:

```text
credentials/
├── client_secret.json
└── token.json
```

Never commit these.

`.gitignore` must include:

```gitignore
.env
.env.*
!.env.example

credentials/
tokens/

recordings/
data/
logs/

*.log
```

---

# 29. Google Drive Folder

Configuration:

```env
GOOGLE_DRIVE_FOLDER_ID=
```

Upload into the configured folder.

Optional date structure:

```text
JKT48 Recordings/
└── 2026/
    └── 09/
        └── 27/
```

Folder creation must be idempotent.

Do not create duplicate folders.

---

# 30. Large File Upload

Large recordings must use a streaming/resumable upload strategy.

Never do:

```js
fs.readFileSync(largeVideo)
```

for multi-gigabyte recordings.

Use:

```js
fs.createReadStream(filePath)
```

and Google Drive resumable upload support.

---

# 31. Upload Queue

The upload queue must be persistent.

Example:

```text
recording 1 → uploading
recording 2 → pending
recording 3 → pending
```

Default concurrency:

```text
1
```

Stream recording must continue while uploads happen.

---

# 32. Upload Retry

Use exponential backoff.

Example:

```text
10 seconds
30 seconds
60 seconds
5 minutes
10 minutes
```

Configuration:

```env
GOOGLE_UPLOAD_RETRY_INITIAL_MS=10000
GOOGLE_UPLOAD_RETRY_MAX_MS=600000
GOOGLE_UPLOAD_MAX_RETRIES=0
```

Use:

```text
0 = unlimited retries
```

unless a different convention is documented.

---

# 33. Upload Verification

After upload:

1. Ensure Drive returns a file ID.
2. Fetch Drive metadata.
3. Verify filename.
4. Verify file size where available.
5. Persist `drive_file_id`.
6. Mark `UPLOADED`.
7. Only then delete local file.

Flow:

```text
local file
   ↓
upload
   ↓
Drive file ID
   ↓
metadata verification
   ↓
UPLOADED
   ↓
delete local file
```

Never delete first.

---

# 34. Local File Deletion

Delete only when all are true:

```text
upload succeeded
AND
Drive file ID exists
AND
verification succeeded
```

Otherwise:

```text
KEEP LOCAL FILE
```

---

# 35. Crash Recovery

At startup:

1. Open SQLite.
2. Find:
   - `PENDING_UPLOAD`
   - `UPLOAD_FAILED`
   - stale `UPLOADING`
3. Verify files still exist.
4. Requeue them.
5. Start monitoring.

For stale `UPLOADING` records, do not assume the upload succeeded.

If a Drive file ID exists, verify it before retrying.

---

# 36. Duplicate Upload Protection

Avoid duplicate Drive files.

Use a combination of:

- database state
- recording ID
- deterministic filename
- Drive file ID
- file size
- optional checksum

Before retrying an uncertain upload, verify whether the expected Drive object already exists.

---

# 37. Disk Space Protection

Configuration:

```env
MIN_FREE_DISK_GB=20
```

Check:

- before recording
- periodically
- before starting a new recording

When below the threshold:

1. log critical warning
2. prioritize uploads
3. avoid starting another recording if necessary
4. never silently delete recordings

---

# 38. Optional Segmentation

Long recordings may optionally be segmented.

Configuration:

```env
SEGMENT_RECORDINGS=false
SEGMENT_DURATION_SECONDS=3600
```

If enabled:

```text
20-00-00.mp4
21-00-00.mp4
22-00-00.mp4
```

Do not enable by default unless tested.

---

# 39. Network Failures

Handle:

- DNS errors
- timeout
- 404
- 403
- 429
- 500
- 502
- 503
- connection reset
- TLS errors

Transient errors must not crash the application.

Use bounded exponential backoff.

---

# 40. HTTP Client

Use Node.js `fetch()` or a reliable HTTP client.

Configure:

- request timeout
- redirect handling
- optional configurable User-Agent

Example:

```env
HTTP_USER_AGENT=JKT48-Stream-Recorder/1.0
```

Do not implement authentication or DRM bypasses.

---

# 41. FFprobe

Use FFprobe where useful for:

- validating finalized recordings
- checking duration
- checking file size
- checking stream/container information

Do not run expensive validation unnecessarily.

---

# 42. Graceful Shutdown

Handle:

```text
SIGINT
SIGTERM
```

Flow:

```text
signal
 ↓
stop monitoring
 ↓
do not start new recordings
 ↓
gracefully stop FFmpeg
 ↓
finalize recording
 ↓
persist pending upload
 ↓
close database
 ↓
exit
```

Configuration:

```env
SHUTDOWN_TIMEOUT_MS=30000
```

If the timeout expires, force termination safely.

---

# 43. Single Instance

Prevent multiple application instances.

Possible mechanisms:

- SQLite application lock
- lock file
- OS mutex

If another instance is running:

```text
exit with clear error
```

This prevents duplicate recordings and uploads.

---

# 44. Logging

Use structured logs.

Required events:

- startup
- configuration validation
- stream check
- stream offline
- stream online
- playlist parsed
- variants found
- selected variant
- recording started
- recording stopped
- FFmpeg exit
- recording finalized
- upload queued
- upload started
- upload retry
- upload verified
- local file deleted
- disk warning
- shutdown
- fatal errors

Do not log:

- OAuth tokens
- refresh tokens
- client secrets
- `.env`
- sensitive signed URLs unnecessarily

---

# 45. Example Log

```text
[20:10:02] INFO  Stream online
[20:10:02] INFO  Master playlist parsed
[20:10:02] INFO  Variants found: 5
[20:10:02] INFO  Selected: 1920x1080 @ 8154731 bps, 60fps
[20:10:03] INFO  Recording started
[20:10:03] INFO  File: recordings/2026/09/27/2026-09-27_20-10-03.mp4
```

After the stream ends:

```text
[21:15:42] INFO  FFmpeg exited
[21:15:43] INFO  Recording finalized
[21:15:43] INFO  Upload queued
[21:15:44] INFO  Google Drive upload started
[21:26:11] INFO  Google Drive upload verified
[21:26:11] INFO  Local file deleted
```

---

# 46. Configuration

Create:

```text
.env.example
```

Example:

```env
NODE_ENV=production

STREAM_URL=https://your-worker-domain.workers.dev/playback

POLL_INTERVAL_MS=10000
REQUEST_TIMEOUT_MS=10000
MAX_CONSECUTIVE_FAILURES=3

RECORDINGS_DIR=./recordings
DATA_DIR=./data
LOG_DIR=./logs

TIMEZONE=Asia/Jakarta

FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe

MIN_RECORDING_SIZE_BYTES=1048576
MIN_FREE_DISK_GB=20

GOOGLE_DRIVE_FOLDER_ID=

GOOGLE_UPLOAD_RETRY_INITIAL_MS=10000
GOOGLE_UPLOAD_RETRY_MAX_MS=600000
GOOGLE_UPLOAD_MAX_RETRIES=0

SHUTDOWN_TIMEOUT_MS=30000

SEGMENT_RECORDINGS=false
SEGMENT_DURATION_SECONDS=3600

LOG_LEVEL=info

DRY_RUN=false
```

---

# 47. Dry Run

Support:

```env
DRY_RUN=true
```

Dry run should:

- fetch `/playback`
- parse master playlist
- show all variants
- select highest resolution
- not create production recordings
- not upload to Drive

Example:

```text
Stream online
Variants: 5
Selected: 1920x1080
DRY_RUN=true
Recording skipped
```

---

# 48. Recommended Project Structure

```text
jkt48-stream-recorder/
│
├── src/
│   ├── index.js
│   ├── config.js
│   ├── logger.js
│   │
│   ├── stream/
│   │   ├── monitor.js
│   │   ├── masterPlaylist.js
│   │   └── variantSelector.js
│   │
│   ├── recording/
│   │   ├── recorder.js
│   │   ├── ffmpeg.js
│   │   └── filename.js
│   │
│   ├── upload/
│   │   ├── googleDrive.js
│   │   └── uploadWorker.js
│   │
│   ├── db/
│   │   ├── database.js
│   │   └── migrations.js
│   │
│   ├── system/
│   │   ├── diskSpace.js
│   │   └── shutdown.js
│   │
│   └── cli/
│       ├── test-stream.js
│       └── test-drive.js
│
├── tests/
│   ├── masterPlaylist.test.js
│   ├── variantSelector.test.js
│   ├── filename.test.js
│   └── ...
│
├── credentials/
├── recordings/
├── data/
├── logs/
│
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
└── README.md
```

The agent may adjust this if an existing repository already has a suitable structure.

---

# 49. npm Scripts

Recommended:

```json
{
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "node --test",
    "test:stream": "node src/cli/test-stream.js",
    "test:drive": "node src/cli/test-drive.js"
  }
}
```

---

# 50. Test Requirements

Automated tests must cover:

## M3U8 parser

- 1080p
- 720p
- 480p
- 360p
- 160p
- missing resolution
- different attribute ordering
- quoted values
- relative URI
- absolute URI
- malformed playlist
- direct media playlist

## Variant selector

Verify:

```text
1080p > 720p
```

and for equal resolution:

```text
higher bandwidth wins
```

## Recording

Test:

- FFmpeg start
- FFmpeg exit
- output file
- process error
- graceful stop

## Upload

Test:

- success
- authentication error
- network failure
- retry
- verification
- cleanup

## Recovery

Test:

- pending upload after restart
- failed upload
- stale uploading status
- already uploaded file

---

# 51. Stream Test Command

Provide:

```bash
npm run test:stream
```

Expected output:

```text
Stream reachable: YES
Master playlist: YES
Variants: 5

Available variants:
- 1920x1080 8154731 bps 60fps
- 1280x720 3422999 bps 60fps
- 852x480 1427999 bps 30fps
- 640x360 630000 bps 30fps
- 284x160 230000 bps 30fps

Selected:
1920x1080
```

It must not start a permanent recording.

---

# 52. Google Drive Test

Provide:

```bash
npm run test:drive
```

It should:

1. authenticate
2. verify Drive access
3. verify configured folder
4. optionally upload a tiny test file
5. verify it
6. optionally delete the test file

Do not upload a real recording during this test.

---

# 53. Optional Health Endpoint

Optional:

```text
GET /health
GET /status
```

Example:

```json
{
  "status": "ok",
  "stream": "online",
  "recording": true,
  "resolution": "1920x1080",
  "pendingUploads": 0
}
```

Never expose:

- OAuth tokens
- credentials
- signed stream URLs
- unnecessary sensitive paths

---

# 54. Status CLI

Provide useful status information:

```text
Status: RECORDING
Stream: ONLINE
Resolution: 1920x1080
FPS: 60
Recording: 2026-09-27_20-10-03.mp4
Pending uploads: 0
Disk free: 182 GB
```

---

# 55. Important Edge Cases

### Stream returns 404

Treat as offline.

### Stream returns 200 but invalid playlist

Treat as unavailable/transient.

### Only 720p exists

Record 720p.

### 1080p disappears temporarily

Do not immediately restart the current recording solely because the master playlist changed.

### FFmpeg exits

Finalize and queue the recording.

### Google Drive unavailable

Keep the recording and retry.

### Server restarts

Recover pending files from SQLite.

### Disk nearly full

Prioritize uploads and avoid starting another recording if necessary.

### Variant URLs change

Fetch the latest master playlist instead of using stale URLs.

### Variant URL ends with `.js`

Accept it if its response is a valid HLS resource.

---

# 56. Things the Agent Must NOT Do

Do not:

- hard-code the current 1080p URL
- assume `.js` means JavaScript
- assume `.m3u8` must appear in the URL
- always choose the first variant
- always choose highest bandwidth regardless of resolution
- transcode unnecessarily
- load multi-gigabyte files into RAM
- delete files before upload verification
- store Google credentials in source code
- use `exec()` with dynamic stream URLs
- silently discard failed recordings
- create duplicate Drive folders
- allow multiple recorder instances
- use aggressive polling
- bypass authentication or DRM
- claim tests passed when they were not actually run

---

# 57. Optional Long-Recording Segmentation

For very long streams, segmentation can be considered later.

Possible strategy:

```text
FFmpeg
   ↓
1-hour segment
   ↓
finalize
   ↓
upload
   ↓
next segment
```

Benefits:

- smaller files
- faster uploads
- lower data-loss risk
- reduced local storage pressure

However, the first implementation should prioritize a reliable single-session recorder unless segmentation is explicitly enabled.

---

# 58. Linux Deployment

Recommended installation:

```text
/opt/jkt48-stream-recorder
```

Run as a dedicated user:

```text
jkt48-recorder
```

Avoid running as root.

Provide a systemd service similar to:

```ini
[Unit]
Description=JKT48 Stream Recorder
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

[Install]
WantedBy=multi-user.target
```

The agent must detect the actual Node.js path before documenting the final service.

---

# 59. Windows Support

Support Windows where practical.

Example:

```env
FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe
FFPROBE_PATH=C:\ffmpeg\bin\ffprobe.exe
```

Core application logic should not depend on Linux-only shell commands.

---

# 60. README Requirements

Generate a complete `README.md` containing:

1. Overview
2. Features
3. Architecture
4. Requirements
5. Node.js installation
6. FFmpeg installation
7. Google Cloud setup
8. OAuth setup
9. Environment variables
10. First run
11. Stream testing
12. Drive testing
13. Recording behavior
14. Highest-resolution selection
15. Upload queue
16. Retry behavior
17. Crash recovery
18. Disk protection
19. Linux/systemd deployment
20. Windows deployment
21. Troubleshooting
22. Security
23. Usage/legal note

---

# 61. Agent Execution Workflow

Before modifying code:

## Step 1 — Inspect

Inspect:

```text
repository
package.json
existing source
.gitignore
OS
Node.js version
FFmpeg version
FFprobe version
```

Do not overwrite an existing application blindly.

## Step 2 — Validate the real stream

Inspect:

```text
HTTP status
Content-Type
redirects
master playlist
variant structure
```

Use the real response to validate assumptions.

## Step 3 — Implement M3U8 parser

Test it independently.

## Step 4 — Implement variant selector

Verify highest resolution selection.

## Step 5 — Implement FFmpeg recorder

Perform a short controlled recording test.

## Step 6 — Implement SQLite persistence

Verify state survives restart.

## Step 7 — Implement Google Drive

Implement OAuth and resumable upload.

## Step 8 — Implement upload worker

Verify retry and verification.

## Step 9 — Implement crash recovery

Simulate interrupted uploads and restart.

## Step 10 — Production deployment

Provide systemd instructions where applicable.

---

# 62. Definition of Done

The project is complete when:

- [ ] Node.js starts successfully
- [ ] configuration validation works
- [ ] `/playback` can be fetched
- [ ] master M3U8 is parsed
- [ ] variants are correctly discovered
- [ ] highest resolution is selected
- [ ] bandwidth is used as a secondary criterion
- [ ] relative URLs work
- [ ] `.js` variant URLs are accepted when they contain HLS
- [ ] direct media playlists are handled
- [ ] FFmpeg records the selected variant
- [ ] recording is finalized safely
- [ ] recording metadata is persisted
- [ ] upload queue persists across restart
- [ ] Google OAuth works
- [ ] Google Drive upload works
- [ ] large files use streaming/resumable upload
- [ ] upload verification works
- [ ] local file is deleted only after verification
- [ ] failed uploads remain locally
- [ ] retry works
- [ ] duplicate uploads are prevented
- [ ] disk space is monitored
- [ ] graceful shutdown works
- [ ] duplicate application instances are prevented
- [ ] logs are useful
- [ ] secrets are not logged
- [ ] automated tests pass
- [ ] stream test passes
- [ ] Drive test passes
- [ ] README is complete
- [ ] `.gitignore` protects credentials and recordings

---

# 63. Final Runtime Flow

The final application should behave like this:

```text
START
  ↓
Load configuration
  ↓
Open SQLite
  ↓
Recover pending uploads
  ↓
Start upload worker
  ↓
Monitor /playback
  ↓
Is stream active?
  │
  ├── NO
  │    ↓
  │  wait
  │    ↓
  │  check again
  │
  └── YES
       ↓
   fetch master M3U8
       ↓
   parse variants
       ↓
   select highest resolution
       ↓
   check disk space
       ↓
   start FFmpeg
       ↓
   record
       ↓
   FFmpeg exits / stream ends
       ↓
   finalize recording
       ↓
   validate file
       ↓
   PENDING_UPLOAD
       ↓
   upload worker
       ↓
   Google Drive upload
       ↓
   verify Drive file
       ↓
   mark UPLOADED
       ↓
   delete local file
       ↓
   return to monitoring
```

---

# 64. Final Agent Instructions

Build the application as a reliable unattended recorder.

Priorities:

1. Data safety
2. Recording reliability
3. Crash recovery
4. Correct HLS master-playlist parsing
5. Correct highest-resolution selection
6. Google Drive upload reliability
7. Security
8. Low resource usage
9. Maintainability
10. Simplicity

The agent must distinguish between:

```text
stream unavailable
```

and:

```text
application failure
```

A temporary offline stream is a normal condition.

A Google Drive outage is a normal recoverable condition.

A network failure is a normal recoverable condition.

The application must remain alive through these conditions.

At completion, report:

```text
Implemented:
- ...

Tested:
- ...

Not tested:
- ...

User configuration still required:
- ...

How to run:
- ...
```

Only report tests that were actually executed.

Only record streams that the operator is authorized to record.
