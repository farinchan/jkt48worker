const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebServer } = require('../src/web/server');
const { AppDatabase } = require('../src/db/database');

test('WebServer provides login, authentication, and dashboard management', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jkt48-test-web-'));
  const dbPath = path.join(testDir, 'test.sqlite');
  const db = new AppDatabase(dbPath);

  const sampleFile = path.join(testDir, 'rec1.mp4');
  fs.writeFileSync(sampleFile, 'dummy-video-data');

  const rec = db.createRecording({
    filename: 'rec1.mp4',
    path: sampleFile,
    status: 'UPLOAD_FAILED',
    youtube_status: 'UPLOAD_FAILED',
    file_size: 1024
  });

  let triggered = false;
  const mockUploadWorker = {
    triggerNow: () => {
      triggered = true;
    }
  };

  const mockRecorder = {
    isRecording: () => false
  };

  const mockMonitor = {
    lastState: 'OFFLINE'
  };

  const config = {
    WEB_PORT: 0, // pick ephemeral free port
    WEB_HOST: '127.0.0.1',
    WEB_PASSWORD: 'secretpassword123',
    STREAM_URL: 'https://test-worker.dev/playback',
    RECORDINGS_DIR: testDir,
    MIN_RECORDING_SIZE_BYTES: 100,
    YOUTUBE_UPLOAD_ENABLED: true,
    YOUTUBE_PRIVACY_STATUS: 'unlisted',
    GOOGLE_DRIVE_FOLDER_ID: ''
  };

  const webServer = new WebServer({
    config,
    db,
    monitor: mockMonitor,
    recorder: mockRecorder,
    uploadWorker: mockUploadWorker,
    logger: null
  });

  await webServer.start();
  const port = webServer.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET / unauthenticated should redirect to /login
    const res1 = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(res1.status, 302);
    assert.equal(res1.headers.get('location'), '/login');

    // 2. GET /login should return 200 with HTML form
    const resLogin = await fetch(`${baseUrl}/login`);
    assert.equal(resLogin.status, 200);
    const loginHtml = await resLogin.text();
    assert.ok(loginHtml.includes('Management Login'));
    assert.ok(loginHtml.includes('input type="password"'));

    // 3. POST /login with incorrect password
    const resBadLogin = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=wrongpassword'
    });
    assert.equal(resBadLogin.status, 200);
    const badLoginHtml = await resBadLogin.text();
    assert.ok(badLoginHtml.includes('Invalid password'));

    // 4. POST /login with correct password
    const resGoodLogin = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=secretpassword123',
      redirect: 'manual'
    });
    assert.equal(resGoodLogin.status, 302);
    const setCookie = resGoodLogin.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.ok(setCookie.includes('session_token='));

    const sessionMatch = setCookie.match(/session_token=([^;]+)/);
    const sessionCookie = `session_token=${sessionMatch[1]}`;

    // 5. GET / with session cookie should return 200 dashboard HTML
    const resDash = await fetch(`${baseUrl}/`, {
      headers: { Cookie: sessionCookie }
    });
    assert.equal(resDash.status, 200);
    const dashHtml = await resDash.text();
    assert.ok(dashHtml.includes('Management Dashboard'));
    assert.ok(dashHtml.includes('rec1.mp4'));
    assert.ok(dashHtml.includes('UPLOAD_FAILED'));

    // 6. POST /actions/trigger-upload
    const resTrigger = await fetch(`${baseUrl}/actions/trigger-upload`, {
      method: 'POST',
      headers: { Cookie: sessionCookie },
      redirect: 'manual'
    });
    assert.equal(resTrigger.status, 302);
    assert.equal(triggered, true);

    // 7. POST /recordings/:id/requeue
    const resRequeue = await fetch(`${baseUrl}/recordings/${rec.id}/requeue`, {
      method: 'POST',
      headers: { Cookie: sessionCookie },
      redirect: 'manual'
    });
    assert.equal(resRequeue.status, 302);
    const requeuedRec = db.getRecordingById(rec.id);
    assert.equal(requeuedRec.status, 'PENDING_UPLOAD');

    // 8. POST /recordings/:id/mark-uploaded
    const resMark = await fetch(`${baseUrl}/recordings/${rec.id}/mark-uploaded`, {
      method: 'POST',
      headers: { Cookie: sessionCookie },
      redirect: 'manual'
    });
    assert.equal(resMark.status, 302);
    const markedRec = db.getRecordingById(rec.id);
    assert.equal(markedRec.status, 'UPLOADED');

    // 9. POST /recordings/:id/delete with file deletion
    assert.ok(fs.existsSync(sampleFile));
    const resDelete = await fetch(`${baseUrl}/recordings/${rec.id}/delete`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'delete_file=1',
      redirect: 'manual'
    });
    assert.equal(resDelete.status, 302);
    assert.ok(!fs.existsSync(sampleFile)); // file removed
    assert.equal(db.getRecordingById(rec.id), null);

    // 10. POST /logout
    const resLogout = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { Cookie: sessionCookie },
      redirect: 'manual'
    });
    assert.equal(resLogout.status, 302);
    assert.equal(resLogout.headers.get('location'), '/login');

    // Now GET / should redirect to /login again
    const resAfterLogout = await fetch(`${baseUrl}/`, {
      headers: { Cookie: sessionCookie },
      redirect: 'manual'
    });
    assert.equal(resAfterLogout.status, 302);
    assert.equal(resAfterLogout.headers.get('location'), '/login');
  } finally {
    await webServer.stop();
    db.close();
  }
});
