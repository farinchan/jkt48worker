const { config } = require('../config');
const { logger } = require('../logger');
const { TelegramNotifier } = require('../notifier/telegram');
const { getDiskSpace } = require('../system/diskSpace');

async function testTelegram() {
  console.log('Testing Telegram Bot Integration');
  console.log('--------------------------------------------------');
  console.log(`TELEGRAM_BOT_ENABLED: ${config.TELEGRAM_BOT_ENABLED}`);
  console.log(`TELEGRAM_CHAT_ID:     ${config.TELEGRAM_CHAT_ID || '(not set)'}`);
  console.log(`TELEGRAM_BOT_TOKEN:   ${config.TELEGRAM_BOT_TOKEN ? '***' + config.TELEGRAM_BOT_TOKEN.slice(-4) : '(not set)'}`);

  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    console.error('\nError: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured in .env');
    console.error('Make sure you have:');
    console.error('  TELEGRAM_BOT_ENABLED=true');
    console.error('  TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ');
    console.error('  TELEGRAM_CHAT_ID=-1001234567890 (or your personal chat ID)');
    process.exit(1);
  }

  // Force enable for test run
  const testConfig = { ...config, TELEGRAM_BOT_ENABLED: true };
  const notifier = new TelegramNotifier({ config: testConfig, logger });

  const disk = getDiskSpace(config.RECORDINGS_DIR);
  const args = process.argv.slice(2);

  let result;
  if (args.includes('--status')) {
    console.log('\nSending Worker Status Report notification to Telegram...');
    result = await notifier.notifyStatusReport({
      isRecording: false,
      activeFile: null,
      queueCount: 0,
      freeDiskGb: disk.freeGb,
      uptimeSeconds: Math.floor(process.uptime())
    });
  } else if (args.includes('--online')) {
    console.log('\nSending Worker Online notification to Telegram...');
    result = await notifier.notifyWorkerStarted({
      nodeEnv: config.NODE_ENV,
      pid: process.pid,
      port: config.WEB_ENABLED ? config.WEB_PORT : null,
      driveEnabled: Boolean(config.GOOGLE_DRIVE_FOLDER_ID),
      youtubeEnabled: Boolean(config.YOUTUBE_UPLOAD_ENABLED),
      freeDiskGb: disk.freeGb,
      streamUrl: config.STREAM_URL
    });
  } else {
    console.log('\nSending Test notification to Telegram...');
    result = await notifier.sendMessage(
      `🤖 <b>JKT48 Stream Auto-Recorder Test</b>\n\n` +
      `Hello! Telegram notifications are configured and functioning properly.\n\n` +
      `• <b>Time:</b> ${new Date().toISOString()}\n` +
      `• <b>Node Environment:</b> ${config.NODE_ENV}\n` +
      `• <b>Free Disk:</b> ${disk.freeGb !== null ? `${disk.freeGb} GB` : '-'}`
    );
  }

  if (result.success) {
    console.log(`\nSuccess! Message delivered to Telegram (Message ID: ${result.messageId}).`);
  } else {
    console.error(`\nFailed to send Telegram message: ${result.error}`);
    process.exit(1);
  }
}

testTelegram().catch((err) => {
  console.error('\nFatal error during Telegram test:', err.message);
  process.exit(1);
});
