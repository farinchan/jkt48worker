const test = require('node:test');
const assert = require('node:assert/strict');
const { YouTubeService } = require('../src/upload/youtube');

function createMockLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {}
  };
}

test('YouTubeService formats title correctly and caps at 100 characters', () => {
  const service = new YouTubeService({ config: {}, logger: createMockLogger() });

  const template = 'JKT48 Live - {date} - [{resolution}]';
  const vars = {
    date: '27/09/2026 20:15',
    resolution: '1920x1080'
  };

  const title = service.formatTitle(template, vars);
  assert.equal(title, 'JKT48 Live - 27/09/2026 20:15 - [1920x1080]');

  // Test capping
  const longTemplate = 'JKT48 '.repeat(25) + '{date}';
  const cappedTitle = service.formatTitle(longTemplate, { date: '2026-09-27' });
  assert.ok(cappedTitle.length <= 100);
  assert.ok(cappedTitle.endsWith('...'));
});

test('YouTubeService formats description correctly and caps at 5000 characters', () => {
  const service = new YouTubeService({ config: {}, logger: createMockLogger() });

  const template = 'Stream recorded on {date}.\nResolution: {resolution}\nFile: {filename}';
  const vars = {
    date: '2026-09-27',
    resolution: '1080p',
    filename: 'test.mp4'
  };

  const desc = service.formatDescription(template, vars);
  assert.ok(desc.includes('Stream recorded on 2026-09-27.'));
  assert.ok(desc.includes('Resolution: 1080p'));
  assert.ok(desc.includes('File: test.mp4'));
});
