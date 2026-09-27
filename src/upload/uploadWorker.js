const fs = require('fs');

class UploadWorker {
  constructor({ config, db, driveService, logger }) {
    this.config = config;
    this.db = db;
    this.driveService = driveService;
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

      // Check if Drive is configured
      if (!this.driveService.isReady) {
        // Attempt lazy initialization
        await this.driveService.initialize();
      }

      if (!this.driveService.isReady) {
        this.logger.debug(
          'Google Drive credentials not configured. Upload queue waiting for authentication.'
        );
        this.isProcessing = false;
        this._scheduleNext(30000);
        return;
      }

      const item = items[0]; // Concurrency = 1
      await this._uploadItem(item);
    } catch (err) {
      this.logger.error({ err: err.message }, 'Unexpected error in upload worker loop');
    } finally {
      this.isProcessing = false;
      this._scheduleNext(5000);
    }
  }

  async _uploadItem(item) {
    if (!fs.existsSync(item.path)) {
      this.logger.error({ id: item.id, path: item.path }, 'Recording file missing on disk; marking INVALID');
      this.db.updateRecording(item.id, {
        status: 'INVALID',
        last_upload_error: 'File does not exist on disk'
      });
      return;
    }

    const maxRetries = this.config.GOOGLE_UPLOAD_MAX_RETRIES; // 0 = unlimited
    if (maxRetries > 0 && item.upload_attempts >= maxRetries) {
      this.logger.warn({ id: item.id, attempts: item.upload_attempts }, 'Max upload retries reached; giving up');
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

      // Verification check (Section 33 & 34)
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

      // Section 34: Local File Deletion ONLY after verified upload
      try {
        if (fs.existsSync(item.path)) {
          fs.unlinkSync(item.path);
          this.logger.info({ id: item.id, path: item.path }, 'Local file deleted');
        }
      } catch (delErr) {
        this.logger.error(
          { id: item.id, path: item.path, err: delErr.message },
          'Failed to delete local file after upload'
        );
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
    }
  }
}

module.exports = {
  UploadWorker
};
