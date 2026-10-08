const fs = require('fs');

class UploadWorker {
  constructor({ config, db, driveService, youtubeService, telegramNotifier, logger }) {
    this.config = config;
    this.db = db;
    this.driveService = driveService;
    this.youtubeService = youtubeService || null;
    this.telegramNotifier = telegramNotifier || null;
    this.logger = logger;
    this.isProcessing = false;
    this.timer = null;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info('Upload worker started');
    this._scheduleNext(1000);
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('Upload worker stopped');
  }

  triggerNow() {
    if (!this.isRunning) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    setImmediate(() => this._processQueue());
  }

  _scheduleNext(ms = 10000) {
    if (!this.isRunning) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._processQueue(), ms);
  }

  calculateBackoff(attempts) {
    const initial = this.config.GOOGLE_UPLOAD_RETRY_INITIAL_MS || 10000;
    const max = this.config.GOOGLE_UPLOAD_RETRY_MAX_MS || 600000;
    const delay = Math.min(initial * Math.pow(2, attempts), max);
    return delay;
  }

  async _processQueue() {
    if (this.isProcessing || !this.isRunning) return;
    this.isProcessing = true;

    try {
      const items = this.db.getPendingUploads();
      if (items.length === 0) {
        this.isProcessing = false;
        this._scheduleNext(10000);
        return;
      }

      const item = items[0]; // Process one item at a time (Concurrency = 1)
      await this._processItem(item);
    } catch (err) {
      this.logger.error({ err: err.message }, 'Unexpected error in upload worker loop');
    } finally {
      this.isProcessing = false;
      this._scheduleNext(5000);
    }
  }

  async _processItem(item) {
    if (!fs.existsSync(item.path)) {
      this.logger.error(
        { id: item.id, path: item.path },
        'Recording file missing on disk; marking INVALID'
      );
      this.db.updateRecording(item.id, {
        status: 'INVALID',
        youtube_status: 'INVALID',
        last_upload_error: 'File does not exist on disk'
      });
      return;
    }

    // 1. Google Drive Upload
    const drivePending = item.status === 'PENDING_UPLOAD' || item.status === 'UPLOAD_FAILED';
    if (drivePending && this.driveService) {
      if (!this.driveService.isReady) {
        await this.driveService.initialize();
      }
      if (this.driveService.isReady) {
        await this._uploadToDrive(item);
      } else {
        this.logger.debug(
          'Google Drive credentials not ready; skipping Drive upload this cycle'
        );
      }
    }

    // Refresh item record from database
    const freshItem = this.db.getRecordingById(item.id);

    // 2. YouTube Upload (if enabled)
    if (this.config.YOUTUBE_UPLOAD_ENABLED && this.youtubeService) {
      const ytPending =
        freshItem.youtube_status === 'PENDING_UPLOAD' || freshItem.youtube_status === 'UPLOAD_FAILED';
      if (ytPending) {
        if (!this.youtubeService.isReady) {
          await this.youtubeService.initialize();
        }
        if (this.youtubeService.isReady) {
          await this._uploadToYouTube(freshItem);
        } else {
          this.logger.debug(
            'YouTube credentials not ready; skipping YouTube upload this cycle'
          );
        }
      }
    } else if (!this.config.YOUTUBE_UPLOAD_ENABLED && freshItem.youtube_status === 'PENDING_UPLOAD') {
      this.db.updateRecording(freshItem.id, { youtube_status: 'SKIPPED' });
    }

    // 3. Cleanup: Check if ALL configured uploads are verified
    const finalItem = this.db.getRecordingById(item.id);
    const driveDone = finalItem.status === 'UPLOADED';
    const youtubeDone =
      !this.config.YOUTUBE_UPLOAD_ENABLED ||
      finalItem.youtube_status === 'UPLOADED' ||
      finalItem.youtube_status === 'SKIPPED';

    if (driveDone && youtubeDone) {
      try {
        if (fs.existsSync(finalItem.path)) {
          fs.unlinkSync(finalItem.path);
          this.logger.info(
            {
              id: finalItem.id,
              path: finalItem.path,
              driveId: finalItem.drive_file_id,
              youtubeId: finalItem.youtube_video_id
            },
            'All uploads completed and verified; local file safely deleted'
          );

          if (this.telegramNotifier) {
            await this.telegramNotifier.notifyAllUploadsComplete({
              filename: finalItem.filename
            });
          }
        }
      } catch (delErr) {
        this.logger.error(
          { id: finalItem.id, path: finalItem.path, err: delErr.message },
          'Failed to delete local file after verified uploads'
        );
      }
    } else {
      this.logger.debug(
        {
          id: finalItem.id,
          driveStatus: finalItem.status,
          youtubeStatus: finalItem.youtube_status
        },
        'Local file retained pending remaining upload destinations'
      );
    }
  }

  async _uploadToDrive(item) {
    const maxRetries = this.config.GOOGLE_UPLOAD_MAX_RETRIES; // 0 = unlimited
    if (maxRetries > 0 && item.upload_attempts >= maxRetries) {
      this.logger.warn(
        { id: item.id, attempts: item.upload_attempts },
        'Max Drive upload retries reached; giving up'
      );
      this.db.updateRecording(item.id, {
        status: 'UPLOAD_FAILED',
        last_upload_error: `Max retries (${maxRetries}) exceeded`
      });
      return;
    }

    this.logger.info({ id: item.id, filename: item.filename }, 'Google Drive upload started');
    this.db.updateRecording(item.id, { status: 'UPLOADING' });

    try {
      const result = await this.driveService.uploadFile({
        filePath: item.path,
        filename: item.filename,
        folderId: this.config.GOOGLE_DRIVE_FOLDER_ID
      });

      if (!result.fileId) {
        throw new Error('Upload succeeded but no Drive file ID returned');
      }

      this.db.updateRecording(item.id, {
        status: 'UPLOADED',
        drive_file_id: result.fileId,
        last_upload_error: null
      });

      this.logger.info(
        { id: item.id, filename: item.filename, fileId: result.fileId },
        'Google Drive upload verified'
      );

      if (this.telegramNotifier) {
        await this.telegramNotifier.notifyDriveSuccess({
          filename: item.filename,
          fileId: result.fileId
        });
      }
    } catch (uploadErr) {
      const nextAttempt = (item.upload_attempts || 0) + 1;
      const backoffMs = this.calculateBackoff(nextAttempt);

      this.logger.error(
        {
          id: item.id,
          filename: item.filename,
          attempt: nextAttempt,
          retryInSeconds: Math.round(backoffMs / 1000),
          error: uploadErr.message
        },
        'Google Drive upload failed; will retry'
      );

      this.db.updateRecording(item.id, {
        status: 'UPLOAD_FAILED',
        upload_attempts: nextAttempt,
        last_upload_error: uploadErr.message
      });

      if (this.telegramNotifier) {
        await this.telegramNotifier.notifyDriveFailure({
          filename: item.filename,
          error: uploadErr.message,
          attempt: nextAttempt
        });
      }
    }
  }

  async _uploadToYouTube(item) {
    const maxRetries = this.config.GOOGLE_UPLOAD_MAX_RETRIES;
    if (maxRetries > 0 && item.youtube_upload_attempts >= maxRetries) {
      this.logger.warn(
        { id: item.id, attempts: item.youtube_upload_attempts },
        'Max YouTube upload retries reached; giving up'
      );
      this.db.updateRecording(item.id, {
        youtube_status: 'UPLOAD_FAILED',
        youtube_last_error: `Max retries (${maxRetries}) exceeded`
      });
      return;
    }

    this.logger.info({ id: item.id, filename: item.filename }, 'YouTube upload started');
    this.db.updateRecording(item.id, { youtube_status: 'UPLOADING' });

    try {
      // Build dynamic metadata variables
      const resolution = item.width && item.height ? `${item.width}x${item.height}` : '1080p';
      const dateStr = item.started_at
        ? new Date(item.started_at).toLocaleString('id-ID', { timeZone: this.config.TIMEZONE })
        : new Date().toLocaleString('id-ID', { timeZone: this.config.TIMEZONE });

      const vars = {
        date: dateStr,
        resolution,
        filename: item.filename,
        baseName: item.filename.replace(/\.mp4$/, '')
      };

      const title = this.youtubeService.formatTitle(this.config.YOUTUBE_TITLE_TEMPLATE, vars);
      const description = this.youtubeService.formatDescription(
        this.config.YOUTUBE_DESCRIPTION_TEMPLATE,
        vars
      );

      const result = await this.youtubeService.uploadVideo({
        filePath: item.path,
        filename: item.filename,
        title,
        description,
        tags: this.config.YOUTUBE_DEFAULT_TAGS,
        privacyStatus: this.config.YOUTUBE_PRIVACY_STATUS,
        categoryId: this.config.YOUTUBE_CATEGORY_ID,
        madeForKids: this.config.YOUTUBE_MADE_FOR_KIDS
      });

      this.db.updateRecording(item.id, {
        youtube_status: 'UPLOADED',
        youtube_video_id: result.videoId,
        youtube_last_error: null
      });

      this.logger.info(
        { id: item.id, videoId: result.videoId, url: result.url },
        'YouTube upload verified'
      );

      if (this.telegramNotifier) {
        await this.telegramNotifier.notifyYouTubeSuccess({
          filename: item.filename,
          videoId: result.videoId,
          url: result.url
        });
      }
    } catch (ytErr) {
      const nextAttempt = (item.youtube_upload_attempts || 0) + 1;
      const backoffMs = this.calculateBackoff(nextAttempt);

      this.logger.error(
        {
          id: item.id,
          filename: item.filename,
          attempt: nextAttempt,
          retryInSeconds: Math.round(backoffMs / 1000),
          error: ytErr.message
        },
        'YouTube upload failed; will retry'
      );

      this.db.updateRecording(item.id, {
        youtube_status: 'UPLOAD_FAILED',
        youtube_upload_attempts: nextAttempt,
        youtube_last_error: ytErr.message
      });

      if (this.telegramNotifier) {
        await this.telegramNotifier.notifyYouTubeFailure({
          filename: item.filename,
          error: ytErr.message,
          attempt: nextAttempt
        });
      }
    }
  }
}

module.exports = {
  UploadWorker
};
