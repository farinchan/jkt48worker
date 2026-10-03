const migrations = [
  {
    version: 1,
    name: 'initial_recordings_and_lock_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS recordings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL UNIQUE,
          path TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          duration_seconds INTEGER,
          width INTEGER,
          height INTEGER,
          bandwidth INTEGER,
          frame_rate REAL,
          source_url TEXT,
          status TEXT NOT NULL,
          file_size INTEGER,
          drive_file_id TEXT,
          upload_attempts INTEGER NOT NULL DEFAULT 0,
          last_upload_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
        CREATE INDEX IF NOT EXISTS idx_recordings_started_at ON recordings(started_at);

        CREATE TABLE IF NOT EXISTS app_lock (
          lock_name TEXT PRIMARY KEY,
          holder_pid INTEGER NOT NULL,
          acquired_at TEXT NOT NULL,
          last_heartbeat TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 2,
    name: 'add_youtube_upload_columns',
    up: (db) => {
      db.exec(`
        ALTER TABLE recordings ADD COLUMN youtube_video_id TEXT;
        ALTER TABLE recordings ADD COLUMN youtube_status TEXT NOT NULL DEFAULT 'SKIPPED';
        ALTER TABLE recordings ADD COLUMN youtube_upload_attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE recordings ADD COLUMN youtube_last_error TEXT;

        CREATE INDEX IF NOT EXISTS idx_recordings_youtube_status ON recordings(youtube_status);
      `);
    }
  }
];

function runMigrations(db, logger) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const rows = db.prepare('SELECT version FROM schema_migrations').all();
  const appliedVersions = new Set(rows.map((r) => r.version));

  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      if (logger) logger.info({ version: migration.version, name: migration.name }, 'Applying database migration');
      const tx = db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
          migration.version,
          new Date().toISOString()
        );
      });
      tx();
    }
  }
}

module.exports = {
  migrations,
  runMigrations
};
