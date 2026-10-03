const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations');

class AppDatabase {
  constructor(dbPath, logger) {
    this.logger = logger;
    const resolvedPath = path.resolve(dbPath);
    const parentDir = path.dirname(resolvedPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    // Use WAL mode for performance and concurrent read/write resilience
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    runMigrations(this.db, this.logger);
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // Application Lock to prevent multiple instances
  acquireLock(lockName = 'jkt48_recorder_main', pid = process.pid) {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT * FROM app_lock WHERE lock_name = ?').get(lockName);

    if (existing) {
      // Check if holder process is still alive
      let isAlive = false;
      try {
        process.kill(existing.holder_pid, 0);
        isAlive = true;
      } catch (err) {
        if (err.code === 'ESRCH') {
          isAlive = false;
        } else {
          // EPERM means process exists but we lack permission to signal
          isAlive = true;
        }
      }

      if (isAlive && existing.holder_pid !== pid) {
        return {
          acquired: false,
          holderPid: existing.holder_pid,
          acquiredAt: existing.acquired_at
        };
      }

      // If holder process is dead, overwrite the stale lock
      this.db
        .prepare(
          'UPDATE app_lock SET holder_pid = ?, acquired_at = ?, last_heartbeat = ? WHERE lock_name = ?'
        )
        .run(pid, now, now, lockName);
      return { acquired: true };
    }

    this.db
      .prepare(
        'INSERT INTO app_lock (lock_name, holder_pid, acquired_at, last_heartbeat) VALUES (?, ?, ?, ?)'
      )
      .run(lockName, pid, now, now);
    return { acquired: true };
  }

  heartbeatLock(lockName = 'jkt48_recorder_main', pid = process.pid) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE app_lock SET last_heartbeat = ? WHERE lock_name = ? AND holder_pid = ?'
      )
      .run(now, lockName, pid);
  }

  releaseLock(lockName = 'jkt48_recorder_main', pid = process.pid) {
    this.db
      .prepare('DELETE FROM app_lock WHERE lock_name = ? AND holder_pid = ?')
      .run(lockName, pid);
  }

  // Recordings CRUD
  createRecording({
    filename,
    path: filePath,
    started_at = new Date().toISOString(),
    width = null,
    height = null,
    bandwidth = null,
    frame_rate = null,
    source_url = null,
    status = 'RECORDING',
    youtube_status = 'SKIPPED'
  }) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO recordings (
        filename, path, started_at, width, height, bandwidth, frame_rate,
        source_url, status, youtube_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      filename,
      filePath,
      started_at,
      width,
      height,
      bandwidth,
      frame_rate,
      source_url,
      status,
      youtube_status,
      now,
      now
    );

    return this.getRecordingById(result.lastInsertRowid);
  }

  getRecordingById(id) {
    return this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) || null;
  }

  getRecordingByFilename(filename) {
    return (
      this.db.prepare('SELECT * FROM recordings WHERE filename = ?').get(filename) || null
    );
  }

  updateRecording(id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return this.getRecordingById(id);

    const now = new Date().toISOString();
    const assignments = [...keys.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ');
    const values = [...keys.map((k) => fields[k]), now, id];

    this.db.prepare(`UPDATE recordings SET ${assignments} WHERE id = ?`).run(...values);
    return this.getRecordingById(id);
  }

  getPendingUploads() {
    return this.db
      .prepare(
        `SELECT * FROM recordings 
         WHERE status IN ('PENDING_UPLOAD', 'UPLOAD_FAILED') 
            OR youtube_status IN ('PENDING_UPLOAD', 'UPLOAD_FAILED')
         ORDER BY id ASC`
      )
      .all();
  }

  getActiveRecordings() {
    return this.db
      .prepare(`SELECT * FROM recordings WHERE status IN ('RECORDING', 'FINALIZING') ORDER BY id ASC`)
      .all();
  }

  getStaleUploadingRecordings() {
    return this.db
      .prepare(
        `SELECT * FROM recordings 
         WHERE status = 'UPLOADING' OR youtube_status = 'UPLOADING' 
         ORDER BY id ASC`
      )
      .all();
  }

  countPendingUploads() {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM recordings 
         WHERE status IN ('PENDING_UPLOAD', 'UPLOADING', 'UPLOAD_FAILED')
            OR youtube_status IN ('PENDING_UPLOAD', 'UPLOADING', 'UPLOAD_FAILED')`
      )
      .get();
    return row ? row.count : 0;
  }

  getRecentRecordings(limit = 10) {
    return this.db
      .prepare('SELECT * FROM recordings ORDER BY id DESC LIMIT ?')
      .all(limit);
  }

  /**
   * Recovers database state on startup (Section 35)
   */
  recoverStartupState(minRecordingSizeBytes = 1048576) {
    const recovered = [];

    // Reset stale UPLOADING back to PENDING_UPLOAD
    const uploading = this.getStaleUploadingRecordings();
    for (const rec of uploading) {
      if (fs.existsSync(rec.path)) {
        const updates = {};
        if (rec.status === 'UPLOADING') {
          updates.status = 'PENDING_UPLOAD';
          updates.last_upload_error = 'Interrupted by application restart';
        }
        if (rec.youtube_status === 'UPLOADING') {
          updates.youtube_status = 'PENDING_UPLOAD';
          updates.youtube_last_error = 'Interrupted by application restart';
        }
        this.updateRecording(rec.id, updates);
        recovered.push({ id: rec.id, filename: rec.filename, action: 'requeued' });
      } else {
        this.updateRecording(rec.id, {
          status: 'INVALID',
          youtube_status: 'INVALID',
          last_upload_error: 'File missing after restart'
        });
        recovered.push({ id: rec.id, filename: rec.filename, action: 'invalid_missing' });
      }
    }

    // Check active recordings that died abruptly during previous run
    const active = this.getActiveRecordings();
    for (const rec of active) {
      const partialPath = rec.path.replace(/\.mp4$/, '.partial.mp4');
      if (fs.existsSync(rec.path)) {
        const stats = fs.statSync(rec.path);
        if (stats.size >= minRecordingSizeBytes) {
          this.updateRecording(rec.id, {
            status: 'PENDING_UPLOAD',
            file_size: stats.size,
            ended_at: new Date().toISOString()
          });
          recovered.push({ id: rec.id, filename: rec.filename, action: 'finalized_and_requeued' });
        } else {
          this.updateRecording(rec.id, {
            status: 'INVALID',
            last_upload_error: 'File too small after restart'
          });
          recovered.push({ id: rec.id, filename: rec.filename, action: 'marked_invalid' });
        }
      } else if (fs.existsSync(partialPath)) {
        // Attempt to rename partial to final
        try {
          const stats = fs.statSync(partialPath);
          if (stats.size >= minRecordingSizeBytes) {
            fs.renameSync(partialPath, rec.path);
            this.updateRecording(rec.id, {
              status: 'PENDING_UPLOAD',
              file_size: stats.size,
              ended_at: new Date().toISOString()
            });
            recovered.push({ id: rec.id, filename: rec.filename, action: 'renamed_and_requeued' });
          } else {
            this.updateRecording(rec.id, {
              status: 'INVALID',
              last_upload_error: 'Partial file too small after restart'
            });
            recovered.push({ id: rec.id, filename: rec.filename, action: 'marked_invalid' });
          }
        } catch (err) {
          this.updateRecording(rec.id, {
            status: 'INVALID',
            last_upload_error: `Failed to recover partial file: ${err.message}`
          });
        }
      } else {
        this.updateRecording(rec.id, {
          status: 'INVALID',
          last_upload_error: 'Recording file missing on restart'
        });
        recovered.push({ id: rec.id, filename: rec.filename, action: 'missing_marked_invalid' });
      }
    }

    return recovered;
  }
}

module.exports = {
  AppDatabase
};
