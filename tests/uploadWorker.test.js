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

test('UploadWorker uploads to Drive, verifies, and deletes local file when YouTube is disabled', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jkt48-test-worker-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const db = new AppDatabase(dbPath);

  const localFile = path.join(tmpDir, 'recording_test.mp4');
  fs.writeFileSync(localFile, Buffer.alloc(5000));

  const rec = db.createRecording({
    filename: 'recording_test.mp4',
    path: localFile,
    status: 'PENDING_UPLOAD',
    youtube_status: 'SKIPPED'
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
      GOOGLE_DRIVE_FOLDER_ID: '',
      YOUTUBE_UPLOAD_ENABLED: false
    },
    db,
    driveService: mockDriveService,
    logger: createMockLogger()
  });

  await worker._processItem(db.getRecordingById(rec.id));

  const updated = db.getRecordingById(rec.id);
  assert.equal(updated.status, 'UPLOADED');
  assert.equal(updated.drive_file_id, 'mock-drive-id-12345');
  // Local file must be deleted after verified upload
  assert.equal(fs.existsSync(localFile), false);

  db.close();
});

test('UploadWorker preserves local file if Drive succeeds but YouTube upload fails', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jkt48-test-worker-dual-fail-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const db = new AppDatabase(dbPath);

  const localFile = path.join(tmpDir, 'recording_dual_fail.mp4');
  fs.writeFileSync(localFile, Buffer.alloc(5000));

  const rec = db.createRecording({
    filename: 'recording_dual_fail.mp4',
    path: localFile,
    status: 'PENDING_UPLOAD',
    youtube_status: 'PENDING_UPLOAD'
  });

  const mockDriveService = {
    isReady: true,
    initialize: async () => true,
    uploadFile: async () => ({
      fileId: 'drive-success-id',
      name: 'recording_dual_fail.mp4',
      size: 5000
    })
  };

  const mockYoutubeService = {
    isReady: true,
    initialize: async () => true,
    formatTitle: (t, v) => `Live - ${v.filename}`,
    formatDescription: (d) => d,
    uploadVideo: async () => {
      throw new Error('YouTube quotaExceeded');
    }
  };

  const worker = new UploadWorker({
    config: {
      GOOGLE_UPLOAD_RETRY_INITIAL_MS: 1000,
      GOOGLE_UPLOAD_RETRY_MAX_MS: 5000,
      GOOGLE_UPLOAD_MAX_RETRIES: 3,
      GOOGLE_DRIVE_FOLDER_ID: '',
      YOUTUBE_UPLOAD_ENABLED: true,
      YOUTUBE_TITLE_TEMPLATE: '{filename}',
      YOUTUBE_DESCRIPTION_TEMPLATE: 'Desc',
      YOUTUBE_DEFAULT_TAGS: ['test'],
      YOUTUBE_PRIVACY_STATUS: 'unlisted',
      YOUTUBE_CATEGORY_ID: '24',
      YOUTUBE_MADE_FOR_KIDS: false
    },
    db,
    driveService: mockDriveService,
    youtubeService: mockYoutubeService,
    logger: createMockLogger()
  });

  await worker._processItem(db.getRecordingById(rec.id));

  const updated = db.getRecordingById(rec.id);
  assert.equal(updated.status, 'UPLOADED');
  assert.equal(updated.drive_file_id, 'drive-success-id');
  assert.equal(updated.youtube_status, 'UPLOAD_FAILED');
  assert.ok(updated.youtube_last_error.includes('quotaExceeded'));

  // Local file MUST be preserved because YouTube has not yet succeeded!
  assert.equal(fs.existsSync(localFile), true);

  db.close();
});

test('UploadWorker deletes local file only when BOTH Drive and YouTube uploads succeed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jkt48-test-worker-dual-ok-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const db = new AppDatabase(dbPath);

  const localFile = path.join(tmpDir, 'recording_dual_ok.mp4');
  fs.writeFileSync(localFile, Buffer.alloc(5000));

  const rec = db.createRecording({
    filename: 'recording_dual_ok.mp4',
    path: localFile,
    status: 'PENDING_UPLOAD',
    youtube_status: 'PENDING_UPLOAD'
  });

  const mockDriveService = {
    isReady: true,
    initialize: async () => true,
    uploadFile: async () => ({
      fileId: 'drive-success-id',
      name: 'recording_dual_ok.mp4',
      size: 5000
    })
  };

  const mockYoutubeService = {
    isReady: true,
    initialize: async () => true,
    formatTitle: (t, v) => `Live - ${v.filename}`,
    formatDescription: (d) => d,
    uploadVideo: async () => ({
      videoId: 'yt-video-id-999',
      title: 'recording_dual_ok.mp4',
      url: 'https://youtu.be/yt-video-id-999'
    })
  };

  const worker = new UploadWorker({
    config: {
      GOOGLE_UPLOAD_RETRY_INITIAL_MS: 1000,
      GOOGLE_UPLOAD_RETRY_MAX_MS: 5000,
      GOOGLE_UPLOAD_MAX_RETRIES: 3,
      GOOGLE_DRIVE_FOLDER_ID: '',
      YOUTUBE_UPLOAD_ENABLED: true,
      YOUTUBE_TITLE_TEMPLATE: '{filename}',
      YOUTUBE_DESCRIPTION_TEMPLATE: 'Desc',
      YOUTUBE_DEFAULT_TAGS: ['test'],
      YOUTUBE_PRIVACY_STATUS: 'unlisted',
      YOUTUBE_CATEGORY_ID: '24',
      YOUTUBE_MADE_FOR_KIDS: false
    },
    db,
    driveService: mockDriveService,
    youtubeService: mockYoutubeService,
    logger: createMockLogger()
  });

  await worker._processItem(db.getRecordingById(rec.id));

  const updated = db.getRecordingById(rec.id);
  assert.equal(updated.status, 'UPLOADED');
  assert.equal(updated.drive_file_id, 'drive-success-id');
  assert.equal(updated.youtube_status, 'UPLOADED');
  assert.equal(updated.youtube_video_id, 'yt-video-id-999');

  // Local file must be deleted now that BOTH succeeded
  assert.equal(fs.existsSync(localFile), false);

  db.close();
});
