const test = require('node:test');
const assert = require('node:assert/strict');
const { selectHighestVariant } = require('../src/stream/variantSelector');

test('selectHighestVariant selects 1080p over 720p', () => {
  const variants = [
    { height: 720, width: 1280, bandwidth: 3500000, frameRate: 60, uri: 'url-720' },
    { height: 1080, width: 1920, bandwidth: 8000000, frameRate: 60, uri: 'url-1080' },
    { height: 480, width: 852, bandwidth: 1400000, frameRate: 30, uri: 'url-480' }
  ];

  const selected = selectHighestVariant(variants);
  assert.equal(selected.height, 1080);
  assert.equal(selected.width, 1920);
  assert.equal(selected.uri, 'url-1080');
});

test('selectHighestVariant selects higher bandwidth for identical resolution', () => {
  const variants = [
    { height: 1080, width: 1920, bandwidth: 6000000, frameRate: 60, uri: 'url-1080-low' },
    { height: 1080, width: 1920, bandwidth: 8500000, frameRate: 60, uri: 'url-1080-high' }
  ];

  const selected = selectHighestVariant(variants);
  assert.equal(selected.bandwidth, 8500000);
  assert.equal(selected.uri, 'url-1080-high');
});

test('selectHighestVariant selects higher frame rate for identical resolution and bandwidth', () => {
  const variants = [
    { height: 720, width: 1280, bandwidth: 3000000, frameRate: 30, uri: 'url-720-30fps' },
    { height: 720, width: 1280, bandwidth: 3000000, frameRate: 60, uri: 'url-720-60fps' }
  ];

  const selected = selectHighestVariant(variants);
  assert.equal(selected.frameRate, 60);
  assert.equal(selected.uri, 'url-720-60fps');
});

test('selectHighestVariant prefers explicit resolution over missing resolution', () => {
  const variants = [
    { height: null, width: null, bandwidth: 10000000, frameRate: 60, uri: 'url-audio-or-unknown' },
    { height: 720, width: 1280, bandwidth: 3000000, frameRate: 60, uri: 'url-720' }
  ];

  const selected = selectHighestVariant(variants);
  assert.equal(selected.height, 720);
  assert.equal(selected.uri, 'url-720');
});

test('selectHighestVariant returns null for empty array or invalid input', () => {
  assert.equal(selectHighestVariant([]), null);
  assert.equal(selectHighestVariant(null), null);
  assert.equal(selectHighestVariant(undefined), null);
});
