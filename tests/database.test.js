const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { AppDatabase } = require('../src/db/database');

function getTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jkt48-test-db-'));
  return path.join(dir, 'test.sqlite');
}

test('AppDatabase initializes schema and migrations correctly', () => {
  const dbPath = getTempDbPath();
  const db = new AppDatabase(dbPath);

  try {
    const rec = db.createRecording({
      filename: '2026-09-27_20-00-00.mp4',
      path: '/path/to/file.mp4',
      width: 1920,
      height: 1080,
      bandwidth: 8000000,
      frame_rate: 60.0,
      source_url: 'https://example.com/live.m3u8'
    });

    assert.ok(rec.id);
    assert.equal(rec.filename, '2026-09-27_20-00-00.mp4');
    assert.equal(rec.status, 'RECORDING');
    assert.equal(rec.youtube_status, 'SKIPPED');
    assert.equal(rec.width, 1920);

    // Update
    const updated = db.updateRecording(rec.id, {
      status: 'PENDING_UPLOAD',
      youtube_status: 'PENDING_UPLOAD',
      file_size: 5000000,
      duration_seconds: 120
    });

    assert.equal(updated.status, 'PENDING_UPLOAD');
    assert.equal(updated.youtube_status, 'PENDING_UPLOAD');
    assert.equal(updated.file_size, 5000000);
    assert.equal(updated.duration_seconds, 120);

    const pending = db.getPendingUploads();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, rec.id);
  } finally {
    db.close();
  }
});

test('AppDatabase acquires and enforces single instance lock', () => {
  const dbPath = getTempDbPath();
  const db1 = new AppDatabase(dbPath);
  const db2 = new AppDatabase(dbPath);

  try {
    const lock1 = db1.acquireLock('test_lock', process.pid);
    assert.equal(lock1.acquired, true);

    // Second instance cannot acquire while process is alive
    // Using a fake living PID (e.g. process.pid) vs another PID
    const lock2 = db2.acquireLock('test_lock', 9999999);
    assert.equal(lock2.acquired, false);
    assert.equal(lock2.holderPid, process.pid);

    // Release lock
    db1.releaseLock('test_lock', process.pid);

    // Now another PID can acquire
    const lock3 = db2.acquireLock('test_lock', process.pid);
    assert.equal(lock3.acquired, true);
  } finally {
    db1.close();
    db2.close();
  }
});

test('AppDatabase recovers interrupted recordings and stale uploads', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jkt48-test-recovery-'));
  const dbPath = path.join(testDir, 'recovery.sqlite');
  const db = new AppDatabase(dbPath);

  try {
    // 1. Create a recording with partial file that exists
    const partialFile = path.join(testDir, 'rec1.partial.mp4');
    const finalFile1 = path.join(testDir, 'rec1.mp4');
    fs.writeFileSync(partialFile, Buffer.alloc(2000000)); // 2MB

    const rec1 = db.createRecording({
      filename: 'rec1.mp4',
      path: finalFile1,
      status: 'RECORDING'
    });

    // 2. Create a stale uploading recording whose file still exists
    const file2 = path.join(testDir, 'rec2.mp4');
    fs.writeFileSync(file2, Buffer.alloc(2000000));
    const rec2 = db.createRecording({
      filename: 'rec2.mp4',
      path: file2,
      status: 'UPLOADING'
    });

    // 3. Create a recording whose file is missing
    const rec3 = db.createRecording({
      filename: 'rec3.mp4',
      path: path.join(testDir, 'missing.mp4'),
      status: 'UPLOADING'
    });

    // Run recovery
    const recovered = db.recoverStartupState(1048576);
    assert.equal(recovered.length, 3);

    // Check rec1: renamed and queued
    assert.ok(fs.existsSync(finalFile1));
    assert.ok(!fs.existsSync(partialFile));
    const updated1 = db.getRecordingById(rec1.id);
    assert.equal(updated1.status, 'PENDING_UPLOAD');

    // Check rec2: reset to PENDING_UPLOAD
    const updated2 = db.getRecordingById(rec2.id);
    assert.equal(updated2.status, 'PENDING_UPLOAD');

    // Check rec3: marked INVALID
    const updated3 = db.getRecordingById(rec3.id);
    assert.equal(updated3.status, 'INVALID');
  } finally {
    db.close();
  }
});
