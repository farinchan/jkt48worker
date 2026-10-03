const fs = require('fs');
const readline = require('readline');
const { config } = require('../config');
const { YouTubeService } = require('../upload/youtube');
const { logger } = require('../logger');

function promptUser(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function testYouTube() {
  console.log('Testing YouTube Data API v3 Integration');
  console.log('--------------------------------------------------');

  const youtubeService = new YouTubeService({ config, logger });
  const secretPath = youtubeService.getClientSecretPath();
  const tokenPath = youtubeService.getYoutubeTokenPath();

  if (!fs.existsSync(secretPath)) {
    console.error(`ERROR: client_secret.json not found at: ${secretPath}`);
    console.log('\nPlease place your Google Cloud OAuth 2.0 client secret file at:');
    console.log(`  ${secretPath}`);
    console.log('\nSteps:');
    console.log('1. Go to Google Cloud Console (https://console.cloud.google.com/)');
    console.log('2. In your existing project, ensure "YouTube Data API v3" is enabled in APIs & Services.');
    console.log('3. Ensure client_secret.json is downloaded to the credentials directory.');
    process.exit(1);
  }

  // Attempt initial load
  await youtubeService.initialize();

  // If token is missing, initiate auth flow
  if (!youtubeService.isReady) {
    console.log('\nYouTube token not found. Initiating OAuth 2.0 flow for YouTube upload scope...\n');
    const authUrl = youtubeService.generateAuthUrl();
    console.log('Authorize this application by visiting this URL in your browser:');
    console.log('--------------------------------------------------');
    console.log(authUrl);
    console.log('--------------------------------------------------\n');

    const code = await promptUser('Enter the authorization code from the browser: ');
    if (!code) {
      console.error('No code provided. Aborting.');
      process.exit(1);
    }

    try {
      await youtubeService.exchangeCodeForToken(code);
      console.log(`\nTokens saved to: ${tokenPath}`);
    } catch (err) {
      console.error(`Authentication error: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\nVerifying YouTube channel access...');
  try {
    const channel = await youtubeService.verifyAccess();
    console.log(`Channel Title:     ${channel.title}`);
    console.log(`Channel ID:        ${channel.channelId}`);
    if (channel.customUrl) console.log(`Custom URL:        ${channel.customUrl}`);
    console.log(`Subscribers:       ${channel.subscriberCount || 'Hidden'}`);
    console.log(`Total Videos:      ${channel.videoCount || '0'}`);

    console.log('\nConfiguration Summary:');
    console.log(`  Upload Enabled:  ${config.YOUTUBE_UPLOAD_ENABLED}`);
    console.log(`  Privacy Status:  ${config.YOUTUBE_PRIVACY_STATUS}`);
    console.log(`  Category ID:     ${config.YOUTUBE_CATEGORY_ID} (Entertainment)`);
    console.log(`  Title Template:  ${config.YOUTUBE_TITLE_TEMPLATE}`);
    console.log(`  Tags:            ${config.YOUTUBE_DEFAULT_TAGS.join(', ')}`);

    console.log('\n--------------------------------------------------');
    console.log('YouTube integration test: ALL CHECKS PASSED');
    console.log('Note: To enable automatic uploads, set YOUTUBE_UPLOAD_ENABLED=true in .env');
    console.log('--------------------------------------------------');
  } catch (err) {
    console.error(`\nYouTube test failed: ${err.message}`);
    process.exit(1);
  }
}

testYouTube();
