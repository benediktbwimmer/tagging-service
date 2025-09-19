import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config';

let dbInstance: Database.Database | null = null;

export type DbClient = Database.Database;

export function getDb(): DbClient {
  if (dbInstance) {
    return dbInstance;
  }

  const { databasePathAbs } = getConfig();
  const dir = path.dirname(databasePathAbs);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(databasePathAbs);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  applyMigrations(db);
  dbInstance = db;
  return dbInstance;
}

const migrations: Array<{ version: number; name: string; up: (db: DbClient) => void }> = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repository_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          last_run_at TEXT,
          runs INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TRIGGER IF NOT EXISTS trg_jobs_updated_at
        AFTER UPDATE ON jobs
        FOR EACH ROW BEGIN
          UPDATE jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
        END;

        CREATE TABLE IF NOT EXISTS job_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          error_message TEXT,
          prompt TEXT,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          cost_usd REAL,
          latency_ms INTEGER,
          raw_response TEXT,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_job_runs_job_id ON job_runs(job_id);

        CREATE TABLE IF NOT EXISTS tag_assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_run_id INTEGER NOT NULL,
          scope TEXT NOT NULL,
          target TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          confidence REAL,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (job_run_id) REFERENCES job_runs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_tag_assignments_job_run_id ON tag_assignments(job_run_id);
        CREATE INDEX IF NOT EXISTS idx_tag_assignments_target ON tag_assignments(target);
      `);
    }
  }
];

function applyMigrations(db: DbClient): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const currentVersion = row.user_version ?? 0;

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    }
  }
}
