const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { generateRecordingFilenames, getDateParts } = require('../src/recording/filename');

test('generateRecordingFilenames generates correct date-based paths and filenames', () => {
  // 2026-09-27T13:15:30Z UTC is 2026-09-27 20:15:30 in Asia/Jakarta (+7)
  const utcDate = new Date('2026-09-27T13:15:30.000Z');
  const result = generateRecordingFilenames(utcDate, 'Asia/Jakarta', '/tmp/recordings');

  assert.equal(result.baseName, '2026-09-27_20-15-30');
  assert.equal(result.filename, '2026-09-27_20-15-30.mp4');
  assert.equal(result.partialFilename, '2026-09-27_20-15-30.partial.mp4');

  const expectedDir = path.resolve('/tmp/recordings', '2026', '09', '27');
  assert.equal(result.targetDir, expectedDir);
  assert.equal(result.finalPath, path.join(expectedDir, '2026-09-27_20-15-30.mp4'));
  assert.equal(result.partialPath, path.join(expectedDir, '2026-09-27_20-15-30.partial.mp4'));
});

test('getDateParts extracts 2-digit zero-padded components', () => {
  const d = new Date('2026-01-05T02:04:08.000Z');
  const parts = getDateParts(d, 'UTC');

  assert.equal(parts.year, '2026');
  assert.equal(parts.month, '01');
  assert.equal(parts.day, '05');
  assert.equal(parts.hour, '02');
  assert.equal(parts.minute, '04');
  assert.equal(parts.second, '08');
});
