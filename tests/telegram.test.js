const test = require('node:test');
const assert = require('node:assert/strict');
const { TelegramNotifier } = require('../src/notifier/telegram');

test('TelegramNotifier checks configuration correctly', () => {
  const disabled = new TelegramNotifier({
    config: { TELEGRAM_BOT_ENABLED: false, TELEGRAM_BOT_TOKEN: '123', TELEGRAM_CHAT_ID: '456' }
  });
  assert.equal(disabled.isConfigured(), false);

  const missingToken = new TelegramNotifier({
    config: { TELEGRAM_BOT_ENABLED: true, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '456' }
  });
  assert.equal(missingToken.isConfigured(), false);

  const missingChat = new TelegramNotifier({
    config: { TELEGRAM_BOT_ENABLED: true, TELEGRAM_BOT_TOKEN: '123', TELEGRAM_CHAT_ID: '' }
  });
  assert.equal(missingChat.isConfigured(), false);

  const valid = new TelegramNotifier({
    config: { TELEGRAM_BOT_ENABLED: true, TELEGRAM_BOT_TOKEN: '123', TELEGRAM_CHAT_ID: '456' }
  });
  assert.equal(valid.isConfigured(), true);
});

test('TelegramNotifier skips sendMessage when unconfigured without throwing', async () => {
  const notifier = new TelegramNotifier({
    config: { TELEGRAM_BOT_ENABLED: false }
  });
  const res = await notifier.sendMessage('Hello');
  assert.equal(res.skipped, true);
});

test('TelegramNotifier sends notification via fetch when configured', async () => {
  const originalFetch = global.fetch;
  let interceptedUrl = null;
  let interceptedBody = null;

  global.fetch = async (url, options) => {
    interceptedUrl = url;
    interceptedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 999 } })
    };
  };

  try {
    const notifier = new TelegramNotifier({
      config: {
        TELEGRAM_BOT_ENABLED: true,
        TELEGRAM_BOT_TOKEN: 'mock_token_123',
        TELEGRAM_CHAT_ID: 'chat_789'
      }
    });

    const res = await notifier.sendMessage('<b>Test alert</b>');
    assert.equal(res.success, true);
    assert.equal(res.messageId, 999);
    assert.equal(interceptedUrl, 'https://api.telegram.org/botmock_token_123/sendMessage');
    assert.equal(interceptedBody.chat_id, 'chat_789');
    assert.equal(interceptedBody.text, '<b>Test alert</b>');
    assert.equal(interceptedBody.parse_mode, 'HTML');

    // Test notifyStreamOnline
    await notifier.notifyStreamOnline({
      variant: { width: 1920, height: 1080, frameRate: 60, bandwidth: 8000000 },
      filename: '2026-10-08_16-00-00.mp4'
    });
    assert.ok(interceptedBody.text.includes('1920x1080'));
    assert.ok(interceptedBody.text.includes('2026-10-08_16-00-00.mp4'));

    // Test notifyRecordingFinished
    await notifier.notifyRecordingFinished({
      filename: '2026-10-08_16-00-00.mp4',
      durationSeconds: 3661,
      fileSize: 104857600,
      status: 'PENDING_UPLOAD'
    });
    assert.ok(interceptedBody.text.includes('1h 1m 1s'));
    assert.ok(interceptedBody.text.includes('100.0 MB'));

    // Test notifyDriveSuccess and notifyDriveFailure
    await notifier.notifyDriveSuccess({ filename: 'test.mp4', fileId: 'drive123' });
    assert.ok(interceptedBody.text.includes('drive123'));

    await notifier.notifyDriveFailure({ filename: 'test.mp4', error: 'Network timeout', attempt: 1 });
    assert.ok(interceptedBody.text.includes('Network timeout'));

    // Test notifyYouTubeSuccess and notifyYouTubeFailure
    await notifier.notifyYouTubeSuccess({ filename: 'test.mp4', videoId: 'yt123', url: 'https://youtu.be/yt123' });
    assert.ok(interceptedBody.text.includes('https://youtu.be/yt123'));

    await notifier.notifyYouTubeFailure({ filename: 'test.mp4', error: 'Quota exceeded', attempt: 2 });
    assert.ok(interceptedBody.text.includes('Quota exceeded'));

    // Test notifyAllUploadsComplete
    await notifier.notifyAllUploadsComplete({ filename: 'test.mp4' });
    assert.ok(interceptedBody.text.includes('All Uploads Verified'));

    // Test notifyLowDiskSpace
    await notifier.notifyLowDiskSpace({ freeGb: 4.5, minFreeGb: 20 });
    assert.ok(interceptedBody.text.includes('4.5 GB'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('TelegramNotifier handles Telegram API errors gracefully', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => {
    return {
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: 'Bad Request: chat not found' })
    };
  };

  try {
    const notifier = new TelegramNotifier({
      config: {
        TELEGRAM_BOT_ENABLED: true,
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHAT_ID: 'invalid_chat'
      }
    });

    const res = await notifier.sendMessage('Hello');
    assert.equal(res.success, false);
    assert.equal(res.error, 'Bad Request: chat not found');
  } finally {
    global.fetch = originalFetch;
  }
});
