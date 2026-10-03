const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

class GoogleDriveService {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.drive = null;
    this.oauth2Client = null;
    this.isReady = false;
  }

  getClientSecretPath() {
    return path.join(this.config.CREDENTIALS_DIR, 'client_secret.json');
  }

  getDriveTokenPath() {
    return path.join(this.config.CREDENTIALS_DIR, 'drive_token.json');
  }

  getGeneralTokenPath() {
    return path.join(this.config.CREDENTIALS_DIR, 'token.json');
  }

  getTokenPath() {
    const drivePath = this.getDriveTokenPath();
    if (fs.existsSync(drivePath)) return drivePath;

    const genPath = this.getGeneralTokenPath();
    if (fs.existsSync(genPath)) {
      try {
        const t = JSON.parse(fs.readFileSync(genPath, 'utf8'));
        if (t.scope && t.scope.includes('drive')) return genPath;
      } catch {
        // ignore
      }
    }
    return drivePath;
  }

  /**
   * Initializes OAuth2 client from local credential files.
   */
  async initialize() {
    const secretPath = this.getClientSecretPath();
    const driveTokenPath = this.getDriveTokenPath();
    const genTokenPath = this.getGeneralTokenPath();

    if (!fs.existsSync(secretPath)) {
      this.logger.warn(
        { secretPath },
        'Google Drive client_secret.json not found. Uploads will be queued locally until credentials are provided.'
      );
      this.isReady = false;
      return false;
    }

    let credentials;
    try {
      const content = fs.readFileSync(secretPath, 'utf8');
      credentials = JSON.parse(content);
    } catch (err) {
      this.logger.error({ err }, 'Failed to parse client_secret.json');
      this.isReady = false;
      return false;
    }

    const key = credentials.installed || credentials.web;
    if (!key) {
      this.logger.error('Invalid client_secret.json: expected "installed" or "web" root object');
      this.isReady = false;
      return false;
    }

    const { client_id, client_secret, redirect_uris } = key;
    this.oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris ? redirect_uris[0] : 'http://localhost'
    );

    // Determine which token file to use
    let tokenPathToUse = null;
    if (fs.existsSync(driveTokenPath)) {
      tokenPathToUse = driveTokenPath;
    } else if (fs.existsSync(genTokenPath)) {
      tokenPathToUse = genTokenPath;
    }

    // Save refreshed tokens automatically
    this.oauth2Client.on('tokens', (tokens) => {
      try {
        const savePath = tokenPathToUse || driveTokenPath;
        let existing = {};
        if (fs.existsSync(savePath)) {
          existing = JSON.parse(fs.readFileSync(savePath, 'utf8'));
        }
        const merged = { ...existing, ...tokens };
        fs.writeFileSync(savePath, JSON.stringify(merged, null, 2));
        this.logger.debug({ savePath }, 'Refreshed and persisted Google Drive OAuth tokens');
      } catch (e) {
        this.logger.error({ err: e }, 'Failed to write updated tokens to Drive token file');
      }
    });

    if (!tokenPathToUse) {
      this.logger.warn(
        { driveTokenPath },
        'Google Drive token not found. Run "npm run test:drive" to authenticate.'
      );
      this.isReady = false;
      return false;
    }

    try {
      const token = JSON.parse(fs.readFileSync(tokenPathToUse, 'utf8'));

      // Verify the token actually has Google Drive scope
      if (token.scope && !token.scope.includes('drive')) {
        this.logger.warn(
          { tokenPath: tokenPathToUse },
          'Token does not have Google Drive scope (https://www.googleapis.com/auth/drive.file). Run "npm run test:drive" to authenticate.'
        );
        this.isReady = false;
        return false;
      }

      this.oauth2Client.setCredentials(token);
      this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
      this.isReady = true;
      this.logger.info({ tokenFile: path.basename(tokenPathToUse) }, 'Google Drive service initialized successfully');
      return true;
    } catch (err) {
      this.logger.error({ err }, 'Failed to load Drive token file');
      this.isReady = false;
      return false;
    }
  }

  /**
   * Generates authorization URL for initial setup.
   */
  generateAuthUrl() {
    if (!this.oauth2Client) {
      throw new Error('OAuth2 client not initialized. Ensure client_secret.json exists.');
    }
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: DRIVE_SCOPES
    });
  }

  /**
   * Exchanges authorization code for tokens and saves to token.json.
   */
  async exchangeCodeForToken(code) {
    if (!this.oauth2Client) {
      throw new Error('OAuth2 client not initialized.');
    }
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    const tokenPath = this.getDriveTokenPath();
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
    this.isReady = true;
    return tokens;
  }

  /**
   * Verifies access to Google Drive and optional target folder.
   */
  async verifyAccess() {
    if (!this.isReady || !this.drive) {
      throw new Error('Google Drive is not authenticated. Please run test:drive.');
    }

    const about = await this.drive.about.get({ fields: 'user(displayName, emailAddress)' });
    const user = about.data.user;

    let folderInfo = null;
    if (this.config.GOOGLE_DRIVE_FOLDER_ID) {
      const folder = await this.drive.files.get({
        fileId: this.config.GOOGLE_DRIVE_FOLDER_ID,
        fields: 'id, name, mimeType, trashed'
      });
      if (folder.data.trashed) {
        throw new Error(`Target folder ${this.config.GOOGLE_DRIVE_FOLDER_ID} is in trash`);
      }
      folderInfo = { id: folder.data.id, name: folder.data.name };
    }

    return {
      authenticatedUser: user,
      targetFolder: folderInfo
    };
  }

  /**
   * Checks if file already exists in target folder (Duplicate Protection).
   */
  async findExistingFile(filename, folderId = null) {
    if (!this.isReady || !this.drive) return null;

    let query = `name = '${filename}' and trashed = false`;
    if (folderId) {
      query += ` and '${folderId}' in parents`;
    }

    const res = await this.drive.files.list({
      q: query,
      fields: 'files(id, name, size, md5Checksum)',
      spaces: 'drive'
    });

    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0];
    }
    return null;
  }

  /**
   * Uploads large file using streaming and resumable upload.
   */
  async uploadFile({ filePath, filename, folderId = null, onProgress = null }) {
    if (!this.isReady || !this.drive) {
      throw new Error('Google Drive service is not ready');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`Local file not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    const targetFolder = folderId || this.config.GOOGLE_DRIVE_FOLDER_ID || null;

    // Check duplicate first
    const existing = await this.findExistingFile(filename, targetFolder);
    if (existing) {
      const remoteSize = parseInt(existing.size, 10);
      if (remoteSize === stat.size) {
        this.logger.info(
          { fileId: existing.id, filename, size: stat.size },
          'File already exists on Google Drive with matching size. Reusing existing file.'
        );
        return {
          fileId: existing.id,
          name: existing.name,
          size: remoteSize,
          reused: true
        };
      }
    }

    const fileMetadata = {
      name: filename
    };
    if (targetFolder) {
      fileMetadata.parents = [targetFolder];
    }

    const media = {
      mimeType: 'video/mp4',
      body: fs.createReadStream(filePath)
    };

    this.logger.info({ filename, sizeBytes: stat.size, targetFolder }, 'Starting Google Drive resumable upload');

    const res = await this.drive.files.create(
      {
        requestBody: fileMetadata,
        media,
        fields: 'id, name, size'
      },
      {
        // Google client supports resumable upload for streams
        uploadType: 'resumable'
      }
    );

    const uploadedFileId = res.data.id;
    if (!uploadedFileId) {
      throw new Error('Drive did not return a valid file ID');
    }

    // Verification step (Section 33)
    const verification = await this.verifyUploadedFile(uploadedFileId, filename, stat.size);

    return {
      fileId: uploadedFileId,
      name: verification.name,
      size: verification.size,
      reused: false
    };
  }

  /**
   * Verifies uploaded file against Drive metadata (Section 33).
   */
  async verifyUploadedFile(fileId, expectedFilename, expectedSize) {
    const meta = await this.drive.files.get({
      fileId,
      fields: 'id, name, size, trashed'
    });

    if (!meta.data || meta.data.trashed) {
      throw new Error(`Upload verification failed: file ${fileId} is invalid or trashed`);
    }

    if (meta.data.name !== expectedFilename) {
      throw new Error(
        `Upload verification failed: expected filename '${expectedFilename}', got '${meta.data.name}'`
      );
    }

    if (meta.data.size && expectedSize) {
      const driveSize = parseInt(meta.data.size, 10);
      if (driveSize !== expectedSize) {
        throw new Error(
          `Upload verification failed: size mismatch (expected ${expectedSize}, got ${driveSize})`
        );
      }
    }

    this.logger.info({ fileId, name: meta.data.name, size: meta.data.size }, 'Upload verification passed');

    return {
      id: meta.data.id,
      name: meta.data.name,
      size: parseInt(meta.data.size, 10) || expectedSize
    };
  }
}

module.exports = {
  GoogleDriveService
};
