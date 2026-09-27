const test = require('node:test');
const assert = require('node:assert/strict');
const { getDiskSpace, checkDiskSpaceSafe } = require('../src/system/diskSpace');

test('getDiskSpace returns valid disk space information on local machine', () => {
  const disk = getDiskSpace(process.cwd());
  assert.ok(disk.freeGb !== null, 'freeGb should not be null');
  assert.ok(disk.totalGb !== null, 'totalGb should not be null');
  assert.ok(disk.freeGb > 0, 'freeGb should be greater than 0');
  assert.ok(disk.totalGb >= disk.freeGb, 'totalGb should be >= freeGb');
});

test('checkDiskSpaceSafe reports sufficient or insufficient correctly', () => {
  const current = getDiskSpace(process.cwd());
  if (current.freeGb !== null) {
    const checkLow = checkDiskSpaceSafe(process.cwd(), 0.001);
    assert.equal(checkLow.isSufficient, true);

    const checkHigh = checkDiskSpaceSafe(process.cwd(), 999999);
    assert.equal(checkHigh.isSufficient, false);
  }
});
