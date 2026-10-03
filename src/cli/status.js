const path = require('path');
const { config } = require('../config');
const { AppDatabase } = require('../db/database');
const { getDiskSpace } = require('../system/diskSpace');

async function showStatus() {
  const dbPath = path.join(config.DATA_DIR, 'recorder.sqlite');
  const db = new AppDatabase(dbPath);

  try {
    const disk = getDiskSpace(config.RECORDINGS_DIR);
    const active = db.getActiveRecordings();
    const pendingCount = db.countPendingUploads();
    const recent = db.getRecentRecordings(5);

    console.log('JKT48 Stream Recorder — Current Status');
    console.log('==================================================');
    console.log(`Node Environment:   ${config.NODE_ENV}`);
    console.log(`Stream Endpoint:    ${config.STREAM_URL}`);
    console.log(`Recordings Dir:     ${config.RECORDINGS_DIR}`);
    console.log(`Disk Free:          ${disk.freeGb !== null ? `${disk.freeGb} GB / ${disk.totalGb} GB` : 'Unknown'}`);
    console.log(`Pending Uploads:    ${pendingCount}`);
    console.log(`YouTube Upload:     ${config.YOUTUBE_UPLOAD_ENABLED ? `ENABLED (${config.YOUTUBE_PRIVACY_STATUS})` : 'DISABLED'}`);

    if (active.length > 0) {
      const rec = active[0];
      console.log('\n[ACTIVE RECORDING]');
      console.log(`Status:             ${rec.status}`);
      console.log(`Filename:           ${rec.filename}`);
      console.log(`Started At:         ${rec.started_at}`);
      console.log(`Resolution:         ${rec.width && rec.height ? `${rec.width}x${rec.height}` : 'unknown'}`);
      console.log(`FPS:                ${rec.frame_rate || 'unknown'}`);
    } else {
      console.log('\nStatus:             MONITORING (No active recording)');
    }

    console.log('\nRecent Recordings:');
    if (recent.length === 0) {
      console.log('  (No recordings logged yet)');
    } else {
      for (const r of recent) {
        const dur = r.duration_seconds ? `${r.duration_seconds}s` : '-';
        const sz = r.file_size ? `${(r.file_size / (1024 * 1024)).toFixed(1)} MB` : '-';
        const ytInfo = r.youtube_video_id ? `YT: https://youtu.be/${r.youtube_video_id}` : `YT: ${r.youtube_status || 'SKIPPED'}`;
        console.log(`  [#${r.id}] ${r.filename} | Drive: ${r.status} | ${ytInfo} | ${dur} | ${sz}`);
      }
    }
    console.log('==================================================');
  } finally {
    db.close();
  }
}

showStatus();
