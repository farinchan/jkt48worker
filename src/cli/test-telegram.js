const { config } = require('../config');
const { logger } = require('../logger');
const { TelegramNotifier } = require('../notifier/telegram');

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

  // If enabled is false in env, force enable for test run
  const testConfig = { ...config, TELEGRAM_BOT_ENABLED: true };
  const notifier = new TelegramNotifier({ config: testConfig, logger });

  console.log('\nSending test message to Telegram...');
  const testMessage = `🤖 <b>JKT48 Stream Auto-Recorder Test</b>\n\n` +
    `Hello! Telegram notifications are configured and functioning properly.\n\n` +
    `• <b>Time:</b> ${new Date().toISOString()}\n` +
    `• <b>Node Environment:</b> ${config.NODE_ENV}`;

  const result = await notifier.sendMessage(testMessage);

  if (result.success) {
    console.log(`\nSuccess! Test message delivered to Telegram (Message ID: ${result.messageId}).`);
  } else {
    console.error(`\nFailed to send Telegram message: ${result.error}`);
    process.exit(1);
  }
}

testTelegram().catch((err) => {
  console.error('\nFatal error during Telegram test:', err.message);
  process.exit(1);
});
