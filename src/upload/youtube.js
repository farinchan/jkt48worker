const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly'
];

class YouTubeService {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.youtube = null;
    this.oauth2Client = null;
    this.isReady = false;
  }

  getClientSecretPath() {
    return path.join(this.config.CREDENTIALS_DIR, 'client_secret.json');
  }

  getYoutubeTokenPath() {
    return path.join(this.config.CREDENTIALS_DIR, 'youtube_token.json');
  }

  getGeneralTokenPath() {
    return path.join(this.config.CREDENTIALS_DIR, 'token.json');
  }

  /**
   * Initializes YouTube OAuth2 client from local credential files.
   */
  async initialize() {
    const secretPath = this.getClientSecretPath();
    const ytTokenPath = this.getYoutubeTokenPath();
    const genTokenPath = this.getGeneralTokenPath();

    if (!fs.existsSync(secretPath)) {
      this.logger.warn(
        { secretPath },
        'Google client_secret.json not found. YouTube uploads will be skipped until credentials are provided.'
      );
      this.isReady = false;
      return false;
    }

    let credentials;
    try {
      const content = fs.readFileSync(secretPath, 'utf8');
      credentials = JSON.parse(content);
    } catch (err) {
      this.logger.error({ err }, 'Failed to parse client_secret.json for YouTube');
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

    // Persist refreshed tokens automatically
    this.oauth2Client.on('tokens', (tokens) => {
      try {
        const targetPath = fs.existsSync(ytTokenPath) ? ytTokenPath : genTokenPath;
        let existing = {};
        if (fs.existsSync(targetPath)) {
          existing = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
        }
        const merged = { ...existing, ...tokens };
        fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2));
        this.logger.debug('Refreshed and persisted YouTube OAuth tokens');
      } catch (e) {
        this.logger.error({ err: e }, 'Failed to write updated YouTube tokens to file');
      }
    });

    // Check youtube_token.json first, then fallback to token.json
    let tokenPathToUse = null;
    if (fs.existsSync(ytTokenPath)) {
      tokenPathToUse = ytTokenPath;
    } else if (fs.existsSync(genTokenPath)) {
      tokenPathToUse = genTokenPath;
    }

    if (!tokenPathToUse) {
      this.logger.warn(
        { ytTokenPath },
        'YouTube token not found. Run "npm run test:youtube" to authenticate with YouTube.'
      );
      this.isReady = false;
      return false;
    }

    try {
      const token = JSON.parse(fs.readFileSync(tokenPathToUse, 'utf8'));

      if (token.scope && !token.scope.includes('youtube')) {
        this.logger.warn(
          { tokenPath: tokenPathToUse },
          'Token does not have YouTube upload scope (https://www.googleapis.com/auth/youtube.upload). Run "npm run test:youtube" to authenticate.'
        );
        this.isReady = false;
        return false;
      }

      this.oauth2Client.setCredentials(token);
      this.youtube = google.youtube({ version: 'v3', auth: this.oauth2Client });
      this.isReady = true;
      this.logger.info({ tokenFile: path.basename(tokenPathToUse) }, 'YouTube service initialized successfully');
      return true;
    } catch (err) {
      this.logger.error({ err }, 'Failed to load YouTube token file');
      this.isReady = false;
      return false;
    }
  }

  /**
   * Generates authorization URL for YouTube upload scope.
   */
  generateAuthUrl() {
    if (!this.oauth2Client) {
      throw new Error('OAuth2 client not initialized. Ensure client_secret.json exists.');
    }
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: YOUTUBE_SCOPES
    });
  }

  /**
   * Exchanges authorization code for tokens and saves to youtube_token.json.
   */
  async exchangeCodeForToken(code) {
    if (!this.oauth2Client) {
      throw new Error('OAuth2 client not initialized.');
    }
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    const tokenPath = this.getYoutubeTokenPath();
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    this.youtube = google.youtube({ version: 'v3', auth: this.oauth2Client });
    this.isReady = true;
    return tokens;
  }

  /**
   * Verifies access to YouTube and retrieves authenticated channel information.
   */
  async verifyAccess() {
    if (!this.isReady || !this.youtube) {
      throw new Error('YouTube service is not authenticated. Please run "npm run test:youtube".');
    }

    const res = await this.youtube.channels.list({
      part: 'snippet,statistics',
      mine: true
    });

    if (!res.data.items || res.data.items.length === 0) {
      throw new Error('No YouTube channel found for the authenticated Google account.');
    }

    const channel = res.data.items[0];
    return {
      channelId: channel.id,
      title: channel.snippet.title,
      customUrl: channel.snippet.customUrl || null,
      subscriberCount: channel.statistics ? channel.statistics.subscriberCount : null,
      videoCount: channel.statistics ? channel.statistics.videoCount : null
    };
  }

  /**
   * Formats video title from template and ensures it meets YouTube limits (<= 100 chars).
   */
  formatTitle(template, variables = {}) {
    let title = template || 'JKT48 Live Stream - {date}';
    for (const [key, val] of Object.entries(variables)) {
      title = title.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val || ''));
    }
    // YouTube allows maximum 100 characters for video title
    if (title.length > 100) {
      title = title.slice(0, 97) + '...';
    }
    return title;
  }

  /**
   * Formats video description from template.
   */
  formatDescription(template, variables = {}) {
    let desc = template || 'Recorded automatically by JKT48 Stream Auto-Recorder\nDate: {date}';
    for (const [key, val] of Object.entries(variables)) {
      desc = desc.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val || ''));
    }
    // YouTube allows maximum 5000 characters for description
    if (desc.length > 5000) {
      desc = desc.slice(0, 4997) + '...';
    }
    return desc;
  }

  /**
   * Uploads large video file using resumable streaming upload to YouTube.
   */
  async uploadVideo({
    filePath,
    filename,
    title,
    description,
    tags = [],
    privacyStatus = 'unlisted',
    categoryId = '24',
    madeForKids = false
  }) {
    if (!this.isReady || !this.youtube) {
      throw new Error('YouTube service is not ready');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`Local file not found for YouTube upload: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    const videoTitle = (title || filename).slice(0, 100);

    const snippet = {
      title: videoTitle,
      description: description || '',
      tags: Array.isArray(tags) ? tags : [],
      categoryId: String(categoryId || '24')
    };

    const status = {
      privacyStatus: ['private', 'unlisted', 'public'].includes(privacyStatus)
        ? privacyStatus
        : 'unlisted',
      selfDeclaredMadeForKids: Boolean(madeForKids)
    };

    this.logger.info(
      {
        filename,
        title: videoTitle,
        privacyStatus: status.privacyStatus,
        sizeBytes: stat.size
      },
      'Starting YouTube resumable video upload'
    );

    let res;
    try {
      res = await this.youtube.videos.insert(
        {
          part: 'snippet,status',
          requestBody: {
            snippet,
            status
          },
          media: {
            mimeType: 'video/mp4',
            body: fs.createReadStream(filePath)
          }
        },
        {
          uploadType: 'resumable'
        }
      );
    } catch (err) {
      // Check for YouTube quota exhaustion
      const errors = err.errors || (err.response && err.response.data && err.response.data.error && err.response.data.error.errors);
      if (errors && Array.isArray(errors)) {
        const isQuota = errors.some(
          (e) => e.reason === 'quotaExceeded' || e.reason === 'dailyUploadLimitExceeded'
        );
        if (isQuota) {
          throw new Error('YouTube API quota exceeded (10,000 units/day limit reached). Upload will retry tomorrow.');
        }
      }
      throw err;
    }

    const videoId = res.data && res.data.id;
    if (!videoId) {
      throw new Error('YouTube API did not return a valid video ID');
    }

    // Verify uploaded video
    const verified = await this.verifyUploadedVideo(videoId, videoTitle);

    this.logger.info(
      {
        videoId,
        title: verified.title,
        url: `https://youtu.be/${videoId}`
      },
      'YouTube video upload and verification completed successfully'
    );

    return {
      videoId,
      title: verified.title,
      url: `https://youtu.be/${videoId}`
    };
  }

  /**
   * Verifies video metadata on YouTube after upload.
   */
  async verifyUploadedVideo(videoId, expectedTitle) {
    const res = await this.youtube.videos.list({
      part: 'snippet,status',
      id: videoId
    });

    if (!res.data.items || res.data.items.length === 0) {
      throw new Error(`YouTube verification failed: video ${videoId} not found`);
    }

    const item = res.data.items[0];
    return {
      videoId: item.id,
      title: item.snippet ? item.snippet.title : expectedTitle,
      privacyStatus: item.status ? item.status.privacyStatus : null
    };
  }
}

module.exports = {
  YouTubeService,
  YOUTUBE_SCOPES
};
