const fs = require('fs');
const path = require('path');
const { generateRecordingFilenames } = require('./filename');
const { startFfmpegRecording, probeMedia } = require('./ffmpeg');
const { checkDiskSpaceSafe } = require('../system/diskSpace');

class StreamRecorder {
  constructor({ config, db, logger }) {
    this.config = config;
    this.db = db;
    this.logger = logger;
    this.currentSession = null;
    this.isStopping = false;
  }

  isRecording() {
    return this.currentSession !== null;
  }

  async startRecording(variant) {
    if (this.currentSession) {
      throw new Error('A recording session is already active');
    }

    // Check disk space before recording
    const disk = checkDiskSpaceSafe(
      this.config.RECORDINGS_DIR,
      this.config.MIN_FREE_DISK_GB,
      this.logger
    );
    if (!disk.isSufficient) {
      throw new Error(
        `Insufficient disk space (${disk.freeGb} GB free, required >= ${this.config.MIN_FREE_DISK_GB} GB)`
      );
    }

    const startTime = new Date();
    const { filename, partialPath, finalPath, targetDir } = generateRecordingFilenames(
      startTime,
      this.config.TIMEZONE,
      this.config.RECORDINGS_DIR
    );

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Create DB entry in RECORDING state
    const dbRecord = this.db.createRecording({
      filename,
      path: finalPath,
      started_at: startTime.toISOString(),
      width: variant.width,
      height: variant.height,
      bandwidth: variant.bandwidth,
      frame_rate: variant.frameRate,
      source_url: variant.uri,
      status: 'RECORDING'
    });

    this.logger.info(
      {
        id: dbRecord.id,
        filename,
        resolution: variant.width && variant.height ? `${variant.width}x${variant.height}` : 'unknown',
        frameRate: variant.frameRate,
        url: variant.uri
      },
      'Recording started'
    );

    const ffmpegSession = startFfmpegRecording({
      ffmpegPath: this.config.FFMPEG_PATH,
      streamUrl: variant.uri,
      outputPath: partialPath,
      logger: this.logger
    });

    const sessionPromise = new Promise((resolve) => {
      ffmpegSession.child.on('close', async (code) => {
        this.logger.info(
          { code, id: dbRecord.id, filename },
          'FFmpeg process exited'
        );
        const finalizeResult = await this._finalizeRecording(
          dbRecord.id,
          partialPath,
          finalPath,
          code,
          ffmpegSession.getStderr()
        );
        this.currentSession = null;
        resolve(finalizeResult);
      });

      ffmpegSession.child.on('error', async (err) => {
        this.logger.error({ err, id: dbRecord.id }, 'FFmpeg process error');
        const finalizeResult = await this._finalizeRecording(
          dbRecord.id,
          partialPath,
          finalPath,
          -1,
          err.message
        );
        this.currentSession = null;
        resolve(finalizeResult);
      });
    });

    this.currentSession = {
      recordId: dbRecord.id,
      ffmpegSession,
      promise: sessionPromise,
      finalPath,
      partialPath,
      startTime
    };

    return {
      recordId: dbRecord.id,
      filename,
      partialPath,
      finalPath,
      sessionPromise
    };
  }

  async stopRecording() {
    if (!this.currentSession) return null;
    this.isStopping = true;
    this.logger.info({ id: this.currentSession.recordId }, 'Stopping recording session gracefully');
    await this.currentSession.ffmpegSession.stopGracefully(this.config.SHUTDOWN_TIMEOUT_MS);
    const result = await this.currentSession.promise;
    this.isStopping = false;
    return result;
  }

  async _finalizeRecording(recordId, partialPath, finalPath, exitCode, stderr) {
    this.logger.info({ recordId }, 'Finalizing recording');
    this.db.updateRecording(recordId, { status: 'FINALIZING' });

    const now = new Date().toISOString();
    let stats = null;

    if (fs.existsSync(partialPath)) {
      stats = fs.statSync(partialPath);
    } else if (fs.existsSync(finalPath)) {
      stats = fs.statSync(finalPath);
    }

    if (!stats || stats.size < this.config.MIN_RECORDING_SIZE_BYTES) {
      const err = `Recording file too small (${stats ? stats.size : 0} bytes < ${this.config.MIN_RECORDING_SIZE_BYTES} bytes). Exit code: ${exitCode}`;
      this.logger.warn({ recordId, err, stderr: stderr.slice(-500) }, 'Invalid recording');
      this.db.updateRecording(recordId, {
        status: 'INVALID',
        ended_at: now,
        file_size: stats ? stats.size : 0,
        last_upload_error: err
      });
      return { success: false, reason: err, recordId };
    }

    // Rename partial to final if needed
    if (fs.existsSync(partialPath) && !fs.existsSync(finalPath)) {
      fs.renameSync(partialPath, finalPath);
    }

    const finalStats = fs.statSync(finalPath);

    // Optionally probe file with ffprobe for duration
    let durationSeconds = null;
    try {
      const probe = await probeMedia(finalPath, this.config.FFPROBE_PATH);
      durationSeconds = probe.duration ? Math.round(probe.duration) : null;
    } catch (probeErr) {
      this.logger.debug({ probeErr: probeErr.message }, 'FFprobe check non-fatal warning');
    }

    const updated = this.db.updateRecording(recordId, {
      status: 'PENDING_UPLOAD',
      file_size: finalStats.size,
      duration_seconds: durationSeconds,
      ended_at: now
    });

    this.logger.info(
      {
        recordId,
        size: finalStats.size,
        durationSeconds,
        finalPath
      },
      'Recording finalized successfully and queued for upload'
    );

    return {
      success: true,
      recording: updated
    };
  }
}

module.exports = {
  StreamRecorder
};
