const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { AppDatabase } = require('../src/db/database');
const { UploadWorker } = require('../src/upload/uploadWorker');

function createMockLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {}
  };
}

test('UploadWorker calculates exponential backoff correctly', () => {
  const config = {
    GOOGLE_UPLOAD_RETRY_INITIAL_MS: 10000,
    GOOGLE_UPLOAD_RETRY_MAX_MS: 600000
  };

  const worker = new UploadWorker({
    config,
    db: null,
    driveService: null,
    logger: createMockLogger()
  });

  assert.equal(worker.calculateBackoff(0), 10000);
  assert.equal(worker.calculateBackoff(1), 20000);
  assert.equal(worker.calculateBackoff(2), 40000);
  assert.equal(worker.calculateBackoff(3), 80000);
  assert.equal(worker.calculateBackoff(10), 600000); // capped at max
});

test('UploadWorker uploads file, verifies, marks UPLOADED, and deletes local file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jkt48-test-worker-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const db = new AppDatabase(dbPath);

  const localFile = path.join(tmpDir, 'recording_test.mp4');
  fs.writeFileSync(localFile, Buffer.alloc(5000));

  const rec = db.createRecording({
    filename: 'recording_test.mp4',
    path: localFile,
    status: 'PENDING_UPLOAD'
  });

  const mockDriveService = {
    isReady: true,
    initialize: async () => true,
    uploadFile: async ({ filePath, filename }) => {
      return {
        fileId: 'mock-drive-id-12345',
        name: filename,
        size: 5000,
        reused: false
      };
    }
  };

  const worker = new UploadWorker({
    config: {
      GOOGLE_UPLOAD_RETRY_INITIAL_MS: 1000,
      GOOGLE_UPLOAD_RETRY_MAX_MS: 5000,
      GOOGLE_UPLOAD_MAX_RETRIES: 3,
      GOOGLE_DRIVE_FOLDER_ID: ''
    },
    db,
    driveService: mockDriveService,
    logger: createMockLogger()
  });

  await worker._uploadItem(db.getRecordingById(rec.id));

  const updated = db.getRecordingById(rec.id);
  assert.equal(updated.status, 'UPLOADED');
  assert.equal(updated.drive_file_id, 'mock-drive-id-12345');
  // Local file must be deleted after verified upload
  assert.equal(fs.existsSync(localFile), false);

  db.close();
});

test('UploadWorker preserves local file on upload error and updates status to UPLOAD_FAILED', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jkt48-test-worker-err-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const db = new AppDatabase(dbPath);

  const localFile = path.join(tmpDir, 'recording_fail.mp4');
  fs.writeFileSync(localFile, Buffer.alloc(5000));

  const rec = db.createRecording({
    filename: 'recording_fail.mp4',
    path: localFile,
    status: 'PENDING_UPLOAD'
  });

  const mockDriveService = {
    isReady: true,
    initialize: async () => true,
    uploadFile: async () => {
      throw new Error('Simulated Google Drive network timeout');
    }
  };

  const worker = new UploadWorker({
    config: {
      GOOGLE_UPLOAD_RETRY_INITIAL_MS: 1000,
      GOOGLE_UPLOAD_RETRY_MAX_MS: 5000,
      GOOGLE_UPLOAD_MAX_RETRIES: 3,
      GOOGLE_DRIVE_FOLDER_ID: ''
    },
    db,
    driveService: mockDriveService,
    logger: createMockLogger()
  });

  await worker._uploadItem(db.getRecordingById(rec.id));

  const updated = db.getRecordingById(rec.id);
  assert.equal(updated.status, 'UPLOAD_FAILED');
  assert.equal(updated.upload_attempts, 1);
  assert.ok(updated.last_upload_error.includes('Simulated Google Drive'));
  // Local file MUST be preserved on failure!
  assert.equal(fs.existsSync(localFile), true);

  db.close();
});
