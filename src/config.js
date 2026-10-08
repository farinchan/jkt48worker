const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

function resolveBinary(binaryName, preferredPath) {
  if (preferredPath && fs.existsSync(preferredPath)) {
    return preferredPath;
  }

  // Check if binary is in PATH
  const isWindows = process.platform === 'win32';
  const name = isWindows && !binaryName.endsWith('.exe') ? `${binaryName}.exe` : binaryName;

  if (preferredPath) {
    // If it's a simple command name or path, check if it exists
    if (fs.existsSync(preferredPath)) return preferredPath;
  }

  // Check common Windows locations
  if (isWindows) {
    const candidates = [
      path.join('C:', 'ffmpeg', 'bin', name),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', name),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', name),
      path.join(process.env.USERPROFILE || '', 'scoop', 'shims', name)
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) return cand;
    }
  }

  // Fallback to configured or binaryName
  return preferredPath || binaryName;
}

function loadConfig() {
  const rootDir = process.cwd();

  const config = {
    NODE_ENV: process.env.NODE_ENV || 'production',

    STREAM_URL: process.env.STREAM_URL || 'https://your-worker-domain.workers.dev/playback',

    POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS, 10) || 10000,
    REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 10000,
    MAX_CONSECUTIVE_FAILURES: parseInt(process.env.MAX_CONSECUTIVE_FAILURES, 10) || 3,

    RECORDINGS_DIR: path.resolve(rootDir, process.env.RECORDINGS_DIR || './recordings'),
    DATA_DIR: path.resolve(rootDir, process.env.DATA_DIR || './data'),
    LOG_DIR: path.resolve(rootDir, process.env.LOG_DIR || './logs'),
    CREDENTIALS_DIR: path.resolve(rootDir, process.env.CREDENTIALS_DIR || './credentials'),

    TIMEZONE: process.env.TIMEZONE || 'Asia/Jakarta',

    FFMPEG_PATH: resolveBinary('ffmpeg', process.env.FFMPEG_PATH),
    FFPROBE_PATH: resolveBinary('ffprobe', process.env.FFPROBE_PATH),

    MIN_RECORDING_SIZE_BYTES: parseInt(process.env.MIN_RECORDING_SIZE_BYTES, 10) || 1048576,
    MIN_FREE_DISK_GB: parseFloat(process.env.MIN_FREE_DISK_GB) || 20,

    // Google Drive Upload Settings
    GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID || '',

    GOOGLE_UPLOAD_RETRY_INITIAL_MS: parseInt(process.env.GOOGLE_UPLOAD_RETRY_INITIAL_MS, 10) || 10000,
    GOOGLE_UPLOAD_RETRY_MAX_MS: parseInt(process.env.GOOGLE_UPLOAD_RETRY_MAX_MS, 10) || 600000,
    GOOGLE_UPLOAD_MAX_RETRIES: parseInt(process.env.GOOGLE_UPLOAD_MAX_RETRIES, 10) || 0,

    // YouTube Upload Settings
    YOUTUBE_UPLOAD_ENABLED: process.env.YOUTUBE_UPLOAD_ENABLED === 'true',
    YOUTUBE_PRIVACY_STATUS: process.env.YOUTUBE_PRIVACY_STATUS || 'unlisted',
    YOUTUBE_TITLE_TEMPLATE: process.env.YOUTUBE_TITLE_TEMPLATE || 'JKT48 Live Stream - {date}',
    YOUTUBE_DESCRIPTION_TEMPLATE:
      process.env.YOUTUBE_DESCRIPTION_TEMPLATE ||
      'Recorded automatically by JKT48 Stream Auto-Recorder\nDate: {date}\nResolution: {resolution}',
    YOUTUBE_CATEGORY_ID: process.env.YOUTUBE_CATEGORY_ID || '24',
    YOUTUBE_DEFAULT_TAGS: (process.env.YOUTUBE_DEFAULT_TAGS || 'JKT48,Live,Stream,Theater,Showroom,IDN')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    YOUTUBE_MADE_FOR_KIDS: process.env.YOUTUBE_MADE_FOR_KIDS === 'true',

    SHUTDOWN_TIMEOUT_MS: parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 30000,

    SEGMENT_RECORDINGS: process.env.SEGMENT_RECORDINGS === 'true',
    SEGMENT_DURATION_SECONDS: parseInt(process.env.SEGMENT_DURATION_SECONDS, 10) || 3600,

    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    DRY_RUN: process.env.DRY_RUN === 'true',
    HTTP_USER_AGENT: process.env.HTTP_USER_AGENT || 'JKT48-Stream-Recorder/1.0',

    // Web Dashboard Management Settings
    WEB_ENABLED: process.env.WEB_ENABLED !== 'false',
    WEB_PORT: parseInt(process.env.WEB_PORT, 10) || 60021,
    WEB_HOST: process.env.WEB_HOST || '0.0.0.0',
    WEB_PASSWORD: process.env.WEB_PASSWORD || 'admin'
  };

  // Ensure directories exist
  [config.RECORDINGS_DIR, config.DATA_DIR, config.LOG_DIR, config.CREDENTIALS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  return Object.freeze(config);
}

module.exports = {
  loadConfig,
  config: loadConfig()
};
