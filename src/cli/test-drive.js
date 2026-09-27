const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { config } = require('../config');
const { GoogleDriveService } = require('../upload/googleDrive');
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

async function testDrive() {
  console.log('Testing Google Drive Integration');
  console.log('--------------------------------------------------');

  const driveService = new GoogleDriveService({ config, logger });
  const secretPath = driveService.getClientSecretPath();
  const tokenPath = driveService.getTokenPath();

  if (!fs.existsSync(secretPath)) {
    console.error(`ERROR: client_secret.json not found at: ${secretPath}`);
    console.log('\nPlease place your Google Cloud OAuth 2.0 client secret file at:');
    console.log(`  ${secretPath}`);
    console.log('\nSteps to create:');
    console.log('1. Go to Google Cloud Console (https://console.cloud.google.com/)');
    console.log('2. Create or select a project.');
    console.log('3. Enable Google Drive API.');
    console.log('4. Create OAuth 2.0 Credentials (type: Desktop App).');
    console.log('5. Download client_secret.json and copy to the credentials folder.');
    process.exit(1);
  }

  // Attempt initial load
  await driveService.initialize();

  // If token.json is missing, initiate auth flow
  if (!driveService.isReady) {
    console.log('\ntoken.json not found. Initiating OAuth 2.0 authentication flow...\n');
    const authUrl = driveService.generateAuthUrl();
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
      await driveService.exchangeCodeForToken(code);
      console.log(`\nTokens saved to: ${tokenPath}`);
    } catch (err) {
      console.error(`Authentication error: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\nVerifying Google Drive access...');
  try {
    const access = await driveService.verifyAccess();
    console.log(`Authenticated as: ${access.authenticatedUser.displayName} (${access.authenticatedUser.emailAddress})`);
    if (access.targetFolder) {
      console.log(`Target folder verified: "${access.targetFolder.name}" (ID: ${access.targetFolder.id})`);
    } else {
      console.log('Target folder: Google Drive root (no GOOGLE_DRIVE_FOLDER_ID specified)');
    }

    // Step 4 & 5: Upload tiny test file
    console.log('\nPerforming test upload (a tiny test file)...');
    const testFileName = `test_verification_${Date.now()}.txt`;
    const tempFilePath = path.join(config.DATA_DIR, testFileName);
    fs.writeFileSync(tempFilePath, `JKT48 Stream Recorder Test Upload - ${new Date().toISOString()}`);

    const uploadResult = await driveService.uploadFile({
      filePath: tempFilePath,
      filename: testFileName
    });

    console.log(`Test upload successful! Drive file ID: ${uploadResult.fileId}`);

    // Verification check
    console.log('Verifying test file on Google Drive...');
    const verified = await driveService.verifyUploadedFile(
      uploadResult.fileId,
      testFileName,
      fs.statSync(tempFilePath).size
    );
    console.log(`Verification confirmed: ${verified.name} (${verified.size} bytes)`);

    // Step 6: Delete test file from Drive and local disk
    console.log('Cleaning up test file on Google Drive...');
    await driveService.drive.files.delete({ fileId: uploadResult.fileId });
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    console.log('Cleanup completed successfully.');

    console.log('\n--------------------------------------------------');
    console.log('Google Drive integration test: ALL CHECKS PASSED');
    console.log('--------------------------------------------------');
  } catch (err) {
    console.error(`\nGoogle Drive test failed: ${err.message}`);
    process.exit(1);
  }
}

testDrive();
