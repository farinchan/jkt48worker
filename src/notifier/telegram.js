function escapeTelegramHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

class TelegramNotifier {
  constructor({ config, logger = null }) {
    this.config = config || {};
    this.logger = logger;
    this.enabled = Boolean(this.config.TELEGRAM_BOT_ENABLED);
    this.token = this.config.TELEGRAM_BOT_TOKEN || '';
    this.chatId = this.config.TELEGRAM_CHAT_ID || '';
  }

  isConfigured() {
    return this.enabled && Boolean(this.token) && Boolean(this.chatId);
  }

  async sendMessage(text, options = {}) {
    if (!this.isConfigured()) {
      return { skipped: true, reason: 'Telegram notifications disabled or missing credentials' };
    }

    const parseMode = options.parse_mode || 'HTML';
    const disableWebPagePreview = options.disable_web_page_preview !== false;

    const payload = {
      chat_id: this.chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: disableWebPagePreview
    };

    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const data = await response.json().catch(() => null);

      if (!response.ok || !data || !data.ok) {
        const errorDesc = data && data.description ? data.description : `HTTP ${response.status}`;
        if (this.logger) {
          this.logger.warn({ err: errorDesc, status: response.status }, 'Telegram sendMessage API call failed');
        }
        return { success: false, error: errorDesc };
      }

      if (this.logger) {
        this.logger.debug({ messageId: data.result ? data.result.message_id : null }, 'Telegram notification sent successfully');
      }

      return { success: true, messageId: data.result ? data.result.message_id : null };
    } catch (err) {
      if (this.logger) {
        this.logger.warn({ err: err.message }, 'Failed to connect to Telegram API');
      }
      return { success: false, error: err.message };
    }
  }

  async notifyWorkerStarted({ nodeEnv, pid, port, driveEnabled, youtubeEnabled, freeDiskGb, streamUrl } = {}) {
    const os = require('os');
    const hostname = escapeTelegramHtml(os.hostname());
    const driveStatus = driveEnabled ? '✅ Active' : '⚪ Disabled';
    const ytStatus = youtubeEnabled ? '✅ Active' : '⚪ Disabled';
    const webStatus = port ? `✅ Running (Port ${port})` : '⚪ Disabled';
    const diskText = freeDiskGb !== undefined && freeDiskGb !== null ? `${freeDiskGb} GB` : '-';
    const streamInfo = streamUrl ? `\n• <b>Stream URL:</b> <code>${escapeTelegramHtml(streamUrl)}</code>` : '';

    const text = `🚀 <b>JKT48 Worker is Online</b>\n\n` +
      `Aplikasi worker auto-recorder aktif dan siap memantau live stream.\n\n` +
      `• <b>Host:</b> <code>${hostname}</code>\n` +
      `• <b>PID:</b> <code>${pid || process.pid}</code>\n` +
      `• <b>Environment:</b> <code>${escapeTelegramHtml(nodeEnv || 'production')}</code>\n` +
      `• <b>Web Dashboard:</b> ${webStatus}\n` +
      `• <b>Google Drive:</b> ${driveStatus}\n` +
      `• <b>YouTube Upload:</b> ${ytStatus}\n` +
      `• <b>Free Disk:</b> <b>${diskText}</b>` +
      streamInfo;

    return this.sendMessage(text);
  }

  async notifyWorkerStopped({ reason = 'Graceful shutdown', uptimeSeconds = 0 } = {}) {
    const os = require('os');
    const hostname = escapeTelegramHtml(os.hostname());
    const uptimeStr = uptimeSeconds ? formatDuration(uptimeSeconds) : '-';

    const text = `🛑 <b>JKT48 Worker Stopped</b>\n\n` +
      `Aplikasi worker telah berhenti beroperasi.\n\n` +
      `• <b>Host:</b> <code>${hostname}</code>\n` +
      `• <b>Alasan:</b> <code>${escapeTelegramHtml(reason)}</code>\n` +
      `• <b>Uptime:</b> ${uptimeStr}`;

    return this.sendMessage(text);
  }

  async notifyStreamOnline({ variant, filename }) {
    const res = variant && variant.width && variant.height ? `${variant.width}x${variant.height}` : 'Auto';
    const fps = variant && variant.frameRate ? ` (${variant.frameRate} fps)` : '';
    const bw = variant && variant.bandwidth ? `\n• <b>Bandwidth:</b> ${(variant.bandwidth / 1000000).toFixed(2)} Mbps` : '';

    const text = `🔴 <b>JKT48 Live Stream Detected</b>\n` +
      `Recording session has started.\n\n` +
      `• <b>File:</b> <code>${escapeTelegramHtml(filename)}</code>\n` +
      `• <b>Resolution:</b> ${res}${fps}` +
      bw;

    return this.sendMessage(text);
  }

  async notifyRecordingFinished({ filename, durationSeconds, fileSize, status }) {
    const dur = durationSeconds ? formatDuration(durationSeconds) : '-';
    const sz = fileSize ? formatBytes(fileSize) : '-';

    const text = `⏹ <b>JKT48 Stream Recording Finished</b>\n` +
      `Stream ended. File finalized and queued for upload.\n\n` +
      `• <b>File:</b> <code>${escapeTelegramHtml(filename)}</code>\n` +
      `• <b>Duration:</b> ${dur}\n` +
      `• <b>Size:</b> ${sz}\n` +
      `• <b>Status:</b> ${escapeTelegramHtml(status)}`;

    return this.sendMessage(text);
  }

  async notifyRecordingFailed({ filename, reason, exitCode } = {}) {
    const text = `❌ <b>Recording Error / Interrupted</b>\n\n` +
      `Perekaman stream terputus atau file tidak valid.\n\n` +
      `• <b>File:</b> <code>${escapeTelegramHtml(filename || '-')}</code>\n` +
      `• <b>Exit Code:</b> <code>${exitCode !== undefined && exitCode !== null ? exitCode : '-'}</code>\n` +
      `• <b>Detail:</b> <code>${escapeTelegramHtml(reason || 'Unknown error')}</code>`;

    return this.sendMessage(text);
  }

  async notifyCrashRecovery({ recoveredCount = 0, items = [] } = {}) {
    const list = items
      .slice(0, 5)
      .map((i) => `• <code>${escapeTelegramHtml(i.filename || 'item')}</code> (${escapeTelegramHtml(i.status || '-')})`)
      .join('\n');
    const extra = items.length > 5 ? `\n...dan ${items.length - 5} lainnya.` : '';

    const text = `🔄 <b>Crash Recovery Executed</b>\n\n` +
      `Ditemukan ${recoveredCount} rekaman dari sesi sebelumnya yang belum selesai. Status rekaman telah dipulihkan.\n\n` +
      (list ? `${list}${extra}` : '');

    return this.sendMessage(text);
  }

  async notifyDriveSuccess({ filename, fileId }) {
    const link = `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
    const text = `☁️ <b>Google Drive Upload Succeeded</b>\n\n` +
      `• <b>File:</b> <code>${escapeTelegramHtml(filename)}</code>\n` +
      `• <b>Link:</b> <a href="${link}">${link}</a>`;

    return this.sendMessage(text);
  }

  async notifyDriveFailure({ filename, error, attempt }) {
    const text = `⚠️ <b>Google Drive Upload Failed</b>\n\n` +
      `• <b>File:</b> <code>${escapeTelegramHtml(filename)}</code>\n` +
      `• <b>Attempt:</b> #${attempt}\n` +
      `• <b>Error:</b> <code>${escapeTelegramHtml(error)}</code>`;

    return this.sendMessage(text);
  }

  async notifyYouTubeSuccess({ filename, videoId, url }) {
    const text = `📺 <b>YouTube Upload Succeeded</b>\n\n` +
      `• <b>File:</b> <code>${escapeTelegramHtml(filename)}</code>\n` +
      `• <b>Watch:</b> <a href="${url}">${url}</a>`;

    return this.sendMessage(text);
  }

  async notifyYouTubeFailure({ filename, error, attempt }) {
    const text = `⚠️ <b>YouTube Upload Failed</b>\n\n` +
      `• <b>File:</b> <code>${escapeTelegramHtml(filename)}</code>\n` +
      `• <b>Attempt:</b> #${attempt}\n` +
      `• <b>Error:</b> <code>${escapeTelegramHtml(error)}</code>`;

    return this.sendMessage(text);
  }

  async notifyAllUploadsComplete({ filename }) {
    const text = `✅ <b>All Uploads Verified</b>\n\n` +
      `• <b>File:</b> <code>${escapeTelegramHtml(filename)}</code>\n` +
      `• Drive and YouTube uploads confirmed.\n` +
      `• Local file safely deleted from storage.`;

    return this.sendMessage(text);
  }

  async notifyLowDiskSpace({ freeGb, minFreeGb }) {
    const text = `🚨 <b>Critical: Low Disk Space Alert</b>\n\n` +
      `• Available space: <b>${freeGb} GB</b>\n` +
      `• Required minimum: <b>${minFreeGb} GB</b>\n` +
      `• Recording paused until disk space is freed!`;

    return this.sendMessage(text);
  }

  async notifyStatusReport({ isRecording = false, activeFile = null, queueCount = 0, freeDiskGb = null, uptimeSeconds = 0 } = {}) {
    const os = require('os');
    const hostname = escapeTelegramHtml(os.hostname());
    const statusText = isRecording
      ? `🔴 Sedang Merekam (<code>${escapeTelegramHtml(activeFile || 'session')}</code>)`
      : '🟢 Standby / Memantau Stream';
    const uptimeStr = uptimeSeconds ? formatDuration(uptimeSeconds) : '-';
    const diskText = freeDiskGb !== undefined && freeDiskGb !== null ? `${freeDiskGb} GB` : '-';

    const text = `📊 <b>JKT48 Worker Status Report</b>\n\n` +
      `• <b>Host:</b> <code>${hostname}</code>\n` +
      `• <b>Status:</b> ${statusText}\n` +
      `• <b>Antrean Upload:</b> <b>${queueCount}</b> file\n` +
      `• <b>Sisa Disk:</b> <b>${diskText}</b>\n` +
      `• <b>Uptime:</b> ${uptimeStr}`;

    return this.sendMessage(text);
  }
}

module.exports = {
  TelegramNotifier,
  escapeTelegramHtml,
  formatBytes,
  formatDuration
};
