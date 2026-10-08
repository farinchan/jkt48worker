const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { getDiskSpace } = require('../system/diskSpace');

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

class WebServer {
  constructor({ config, db, monitor, recorder, uploadWorker, logger }) {
    this.config = config;
    this.db = db;
    this.monitor = monitor;
    this.recorder = recorder;
    this.uploadWorker = uploadWorker;
    this.logger = logger;
    this.server = null;
    this.sessions = new Map(); // token -> expiry
  }

  start() {
    return new Promise((resolve, reject) => {
      const port = this.config.WEB_PORT || 60021;
      const host = this.config.WEB_HOST || '0.0.0.0';

      this.server = http.createServer(this._handleRequest.bind(this));

      this.server.on('error', (err) => {
        if (this.logger) {
          this.logger.error({ err: err.message, port, host }, 'Web server failed to start');
        }
        reject(err);
      });

      this.server.listen(port, host, () => {
        if (this.logger) {
          this.logger.info(
            { port, host, url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}` },
            'Web management server started'
          );
        }
        resolve(this.server);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          if (this.logger) {
            this.logger.info('Web management server stopped');
          }
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  _parseCookies(req) {
    const list = {};
    const rc = req.headers.cookie;
    if (!rc) return list;

    rc.split(';').forEach((cookie) => {
      const parts = cookie.split('=');
      const name = parts.shift().trim();
      const val = decodeURIComponent(parts.join('='));
      list[name] = val;
    });

    return list;
  }

  _isAuthenticated(req) {
    // If no password configured, consider auth bypassed
    if (!this.config.WEB_PASSWORD) return true;

    const cookies = this._parseCookies(req);
    const token = cookies.session_token;
    if (!token) return false;

    const expiry = this.sessions.get(token);
    if (!expiry) return false;

    if (Date.now() > expiry) {
      this.sessions.delete(token);
      return false;
    }

    return true;
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1e6) {
          // 1MB max body size
          req.connection.destroy();
          reject(new Error('Body payload too large'));
        }
      });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const data = {};
        for (const [k, v] of params.entries()) {
          data[k] = v;
        }
        resolve(data);
      });
      req.on('error', reject);
    });
  }

  async _handleRequest(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method.toUpperCase();

      // Route: GET /login
      if (pathname === '/login' && method === 'GET') {
        if (this._isAuthenticated(req)) {
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }
        this._renderLogin(req, res);
        return;
      }

      // Route: POST /login
      if (pathname === '/login' && method === 'POST') {
        const body = await this._readBody(req);
        const inputPassword = body.password || '';
        const expectedPassword = this.config.WEB_PASSWORD || 'admin';

        if (inputPassword === expectedPassword) {
          const sessionToken = crypto.randomBytes(32).toString('hex');
          const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days
          this.sessions.set(sessionToken, Date.now() + maxAgeMs);

          res.writeHead(302, {
            'Set-Cookie': `session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
            Location: '/?msg=logged_in'
          });
          res.end();
        } else {
          this._renderLogin(req, res, 'Invalid password. Please try again.');
        }
        return;
      }

      // Route: POST /logout
      if (pathname === '/logout' && method === 'POST') {
        const cookies = this._parseCookies(req);
        if (cookies.session_token) {
          this.sessions.delete(cookies.session_token);
        }
        res.writeHead(302, {
          'Set-Cookie': 'session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
          Location: '/login'
        });
        res.end();
        return;
      }

      // Route: GET /api/status (JSON, require auth)
      if (pathname === '/api/status' && method === 'GET') {
        if (!this._isAuthenticated(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const status = this._getSystemStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status, null, 2));
        return;
      }

      // Enforce auth for all subsequent routes
      if (!this._isAuthenticated(req)) {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
      }

      // Route: POST /actions/trigger-upload
      if (pathname === '/actions/trigger-upload' && method === 'POST') {
        if (this.uploadWorker) {
          this.uploadWorker.triggerNow();
        }
        res.writeHead(302, { Location: '/?msg=upload_triggered' });
        res.end();
        return;
      }

      // Route: POST /actions/recover
      if (pathname === '/actions/recover' && method === 'POST') {
        let count = 0;
        if (this.db) {
          const rec = this.db.recoverStartupState(this.config.MIN_RECORDING_SIZE_BYTES);
          count = rec.length;
        }
        res.writeHead(302, { Location: `/?msg=recovered&count=${count}` });
        res.end();
        return;
      }

      // Route: POST /recordings/:id/requeue
      const requeueMatch = pathname.match(/^\/recordings\/(\d+)\/requeue$/);
      if (requeueMatch && method === 'POST') {
        const id = parseInt(requeueMatch[1], 10);
        if (this.db) {
          this.db.requeueRecording(id);
        }
        if (this.uploadWorker) {
          this.uploadWorker.triggerNow();
        }
        res.writeHead(302, { Location: `/?msg=requeued&id=${id}` });
        res.end();
        return;
      }

      // Route: POST /recordings/:id/mark-uploaded
      const markUploadedMatch = pathname.match(/^\/recordings\/(\d+)\/mark-uploaded$/);
      if (markUploadedMatch && method === 'POST') {
        const id = parseInt(markUploadedMatch[1], 10);
        if (this.db) {
          this.db.updateRecording(id, {
            status: 'UPLOADED',
            youtube_status: this.config.YOUTUBE_UPLOAD_ENABLED ? 'UPLOADED' : 'SKIPPED'
          });
        }
        res.writeHead(302, { Location: `/?msg=marked_uploaded&id=${id}` });
        res.end();
        return;
      }

      // Route: POST /recordings/:id/delete
      const deleteMatch = pathname.match(/^\/recordings\/(\d+)\/delete$/);
      if (deleteMatch && method === 'POST') {
        const id = parseInt(deleteMatch[1], 10);
        const body = await this._readBody(req);
        const deleteFile = body.delete_file === '1';
        if (this.db) {
          this.db.deleteRecording(id, deleteFile);
        }
        res.writeHead(302, { Location: `/?msg=deleted&id=${id}` });
        res.end();
        return;
      }

      // Route: GET /
      if (pathname === '/' && method === 'GET') {
        this._renderDashboard(req, res, url);
        return;
      }

      // Fallback 404
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    } catch (err) {
      if (this.logger) {
        this.logger.error({ err: err.message, stack: err.stack }, 'Error handling web request');
      }
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Internal Server Error: ${err.message}`);
    }
  }

  _getSystemStatus() {
    const disk = getDiskSpace(this.config.RECORDINGS_DIR);
    const activeRecordings = this.db ? this.db.getActiveRecordings() : [];
    const pendingUploads = this.db ? this.db.countPendingUploads() : 0;
    const isRecording = this.recorder ? this.recorder.isRecording() : false;
    const monitorState = this.monitor ? this.monitor.lastState : 'UNKNOWN';

    return {
      streamUrl: this.config.STREAM_URL,
      monitorState,
      isRecording,
      activeRecordings,
      pendingUploads,
      disk,
      youtubeEnabled: this.config.YOUTUBE_UPLOAD_ENABLED,
      youtubePrivacy: this.config.YOUTUBE_PRIVACY_STATUS,
      driveFolderId: this.config.GOOGLE_DRIVE_FOLDER_ID ? 'Configured' : 'Root',
      uptimeSeconds: Math.floor(process.uptime())
    };
  }

  _renderLogin(req, res, error = null) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Login — JKT48 Stream Recorder</title>
  <style>
    body { font-family: sans-serif; margin: 40px auto; max-width: 360px; line-height: 1.5; }
    fieldset { padding: 20px; border: 1px solid #aaa; }
    legend { font-weight: bold; }
    .form-group { margin-bottom: 15px; }
    label { display: block; margin-bottom: 5px; font-size: 14px; }
    input[type="password"] { width: 100%; padding: 8px; box-sizing: border-box; font-size: 14px; }
    button { padding: 8px 16px; font-size: 14px; cursor: pointer; }
    .error { color: #d00; font-size: 13px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <h2>JKT48 Stream Recorder</h2>
  <form method="POST" action="/login">
    <fieldset>
      <legend>Management Login</legend>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      <div class="form-group">
        <label for="password">Password:</label>
        <input type="password" id="password" name="password" required autofocus />
      </div>
      <button type="submit">Log In</button>
    </fieldset>
  </form>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  _renderDashboard(req, res, url) {
    const statusFilter = url.searchParams.get('status') || 'ALL';
    const page = parseInt(url.searchParams.get('page'), 10) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;

    const msg = url.searchParams.get('msg');
    const msgId = url.searchParams.get('id');
    const msgCount = url.searchParams.get('count');

    let flashMessage = '';
    if (msg === 'logged_in') flashMessage = 'Welcome to JKT48 Stream Recorder Management.';
    else if (msg === 'upload_triggered') flashMessage = 'Upload worker triggered successfully.';
    else if (msg === 'recovered') flashMessage = `State recovery completed. Recovered items: ${msgCount || 0}.`;
    else if (msg === 'requeued') flashMessage = `Recording #${msgId} requeued for upload.`;
    else if (msg === 'marked_uploaded') flashMessage = `Recording #${msgId} marked as UPLOADED.`;
    else if (msg === 'deleted') flashMessage = `Recording #${msgId} deleted successfully.`;

    const status = this._getSystemStatus();
    const totalCount = this.db ? this.db.countRecordings(statusFilter) : 0;
    const recordings = this.db ? this.db.getAllRecordings({ limit, offset, status: statusFilter }) : [];
    const totalPages = Math.ceil(totalCount / limit) || 1;

    const uptimeH = Math.floor(status.uptimeSeconds / 3600);
    const uptimeM = Math.floor((status.uptimeSeconds % 3600) / 60);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>JKT48 Stream Recorder Management</title>
  <style>
    body { font-family: monospace, sans-serif; margin: 20px; font-size: 13px; line-height: 1.4; }
    h1, h2, h3 { margin-top: 0; }
    fieldset { margin-bottom: 16px; border: 1px solid #999; padding: 12px; }
    legend { font-weight: bold; }
    .flash { background: #e8f5e9; border: 1px solid #4caf50; padding: 8px 12px; margin-bottom: 16px; color: #2e7d32; font-weight: bold; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #888; padding: 6px; text-align: left; }
    th { background: #eee; }
    tr:nth-child(even) { background: #fdfdfd; }
    .btn { padding: 4px 8px; font-size: 12px; cursor: pointer; }
    .btn-danger { color: #900; }
    .filter-links { margin-bottom: 10px; }
    .filter-links a { margin-right: 12px; }
    .filter-active { font-weight: bold; text-decoration: underline; }
    .status-badge { font-weight: bold; }
    .status-RECORDING { color: #e65100; }
    .status-PENDING_UPLOAD { color: #0277bd; }
    .status-UPLOADING { color: #1565c0; }
    .status-UPLOADED { color: #2e7d32; }
    .status-UPLOAD_FAILED { color: #c62828; }
    .status-INVALID { color: #757575; }
    .status-SKIPPED { color: #9e9e9e; }
    .nav-bar { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #333; padding-bottom: 8px; margin-bottom: 16px; }
  </style>
</head>
<body>

  <div class="nav-bar">
    <div>
      <h2 style="margin:0">JKT48 Stream Recorder — Management Dashboard</h2>
    </div>
    <div>
      <form method="POST" action="/logout" style="display:inline">
        <button type="submit" class="btn">Logout</button>
      </form>
    </div>
  </div>

  ${flashMessage ? `<div class="flash">${escapeHtml(flashMessage)}</div>` : ''}

  <!-- System Overview -->
  <fieldset>
    <legend>System Status</legend>
    <table style="width: auto; margin-bottom: 10px;">
      <tr><td><strong>Stream Status:</strong></td><td>${status.isRecording ? '<span style="color:red;font-weight:bold;">● RECORDING IN PROGRESS</span>' : (status.monitorState === 'ONLINE' ? '<span style="color:green;font-weight:bold;">● STREAM ONLINE</span>' : '○ MONITORING (Offline)')}</td></tr>
      <tr><td><strong>Stream URL:</strong></td><td>${escapeHtml(status.streamUrl)}</td></tr>
      <tr><td><strong>Disk Free:</strong></td><td>${status.disk.freeGb !== null ? `${status.disk.freeGb} GB / ${status.disk.totalGb} GB` : 'Unknown'}</td></tr>
      <tr><td><strong>Upload Queue:</strong></td><td>${status.pendingUploads} pending</td></tr>
      <tr><td><strong>Google Drive:</strong></td><td>${status.driveFolderId}</td></tr>
      <tr><td><strong>YouTube Upload:</strong></td><td>${status.youtubeEnabled ? `ENABLED (${status.youtubePrivacy})` : 'DISABLED'}</td></tr>
      <tr><td><strong>Process Uptime:</strong></td><td>${uptimeH}h ${uptimeM}m</td></tr>
    </table>

    <div style="margin-top: 10px;">
      <form method="POST" action="/actions/trigger-upload" style="display:inline">
        <button type="submit" class="btn">Trigger Upload Worker Now</button>
      </form>
      &nbsp;
      <form method="POST" action="/actions/recover" style="display:inline">
        <button type="submit" class="btn">Recover / Check Stale Uploads</button>
      </form>
      &nbsp;
      <a href="/" class="btn" style="text-decoration:none; display:inline-block; border:1px solid #777; background:#efefef; color:#000;">Refresh</a>
    </div>
  </fieldset>

  <!-- Active Recordings -->
  ${status.activeRecordings.length > 0 ? `
  <fieldset>
    <legend>Active Recording Session</legend>
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Filename</th>
          <th>Started At</th>
          <th>Resolution</th>
          <th>FPS</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${status.activeRecordings.map((r) => `
        <tr>
          <td>#${r.id}</td>
          <td>${escapeHtml(r.filename)}</td>
          <td>${escapeHtml(r.started_at)}</td>
          <td>${r.width && r.height ? `${r.width}x${r.height}` : '-'}</td>
          <td>${r.frame_rate || '-'}</td>
          <td><span class="status-badge status-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </fieldset>` : ''}

  <!-- Recordings Table -->
  <fieldset>
    <legend>Recordings History (${totalCount} total)</legend>

    <div class="filter-links">
      Filter: 
      <a href="/?status=ALL" class="${statusFilter === 'ALL' ? 'filter-active' : ''}">All (${this.db ? this.db.countRecordings('ALL') : 0})</a>
      <a href="/?status=PENDING_UPLOAD" class="${statusFilter === 'PENDING_UPLOAD' ? 'filter-active' : ''}">Pending (${this.db ? this.db.countRecordings('PENDING_UPLOAD') : 0})</a>
      <a href="/?status=UPLOADED" class="${statusFilter === 'UPLOADED' ? 'filter-active' : ''}">Uploaded (${this.db ? this.db.countRecordings('UPLOADED') : 0})</a>
      <a href="/?status=UPLOAD_FAILED" class="${statusFilter === 'UPLOAD_FAILED' ? 'filter-active' : ''}">Failed (${this.db ? this.db.countRecordings('UPLOAD_FAILED') : 0})</a>
      <a href="/?status=INVALID" class="${statusFilter === 'INVALID' ? 'filter-active' : ''}">Invalid (${this.db ? this.db.countRecordings('INVALID') : 0})</a>
    </div>

    ${recordings.length === 0 ? '<p>No recordings found matching this filter.</p>' : `
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Filename</th>
          <th>Started At</th>
          <th>Duration</th>
          <th>Size</th>
          <th>Res</th>
          <th>Local</th>
          <th>Drive Status</th>
          <th>YouTube Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${recordings.map((r) => {
          const fileExists = fs.existsSync(r.path);
          const driveLink = r.drive_file_id ? ` <a href="https://drive.google.com/file/d/${escapeHtml(r.drive_file_id)}/view" target="_blank">[View]</a>` : '';
          const ytLink = r.youtube_video_id ? ` <a href="https://youtu.be/${escapeHtml(r.youtube_video_id)}" target="_blank">[Watch]</a>` : '';
          const isUploaded = r.status === 'UPLOADED';

          return `<tr>
            <td>#${r.id}</td>
            <td title="${escapeHtml(r.path)}">${escapeHtml(r.filename)}</td>
            <td>${escapeHtml(r.started_at ? r.started_at.replace('T', ' ').substring(0, 19) : '-')}</td>
            <td>${formatDuration(r.duration_seconds)}</td>
            <td>${formatBytes(r.file_size)}</td>
            <td>${r.width && r.height ? `${r.width}x${r.height}` : '-'}</td>
            <td>${fileExists ? '<span style="color:green">YES</span>' : '<span style="color:#888">NO</span>'}</td>
            <td>
              <span class="status-badge status-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>${driveLink}
              ${r.last_upload_error ? `<br><small style="color:red">${escapeHtml(r.last_upload_error)}</small>` : ''}
            </td>
            <td>
              <span class="status-badge status-${escapeHtml(r.youtube_status)}">${escapeHtml(r.youtube_status)}</span>${ytLink}
              ${r.youtube_last_error ? `<br><small style="color:red">${escapeHtml(r.youtube_last_error)}</small>` : ''}
            </td>
            <td style="white-space:nowrap;">
              ${!isUploaded ? `
              <form method="POST" action="/recordings/${r.id}/requeue" style="display:inline;">
                <button type="submit" class="btn">Requeue</button>
              </form>
              <form method="POST" action="/recordings/${r.id}/mark-uploaded" style="display:inline;">
                <button type="submit" class="btn">Mark Done</button>
              </form>
              ` : ''}
              <form method="POST" action="/recordings/${r.id}/delete" style="display:inline;" onsubmit="return confirm('Delete recording #${r.id}?');">
                <label style="font-size:11px;"><input type="checkbox" name="delete_file" value="1">del file</label>
                <button type="submit" class="btn btn-danger">Delete</button>
              </form>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    `}

    <!-- Pagination -->
    ${totalPages > 1 ? `
    <div style="margin-top: 12px;">
      Page: 
      ${page > 1 ? `<a href="/?status=${statusFilter}&page=${page - 1}">&laquo; Prev</a>` : ''}
      <span>${page} of ${totalPages}</span>
      ${page < totalPages ? `<a href="/?status=${statusFilter}&page=${page + 1}">Next &raquo;</a>` : ''}
    </div>` : ''}
  </fieldset>

</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}

module.exports = {
  WebServer
};
