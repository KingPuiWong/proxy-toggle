import { mkdirSync, readdirSync, readFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const CURRENT_DIR = path.dirname(CURRENT_FILE);
const PROJECT_ROOT = path.resolve(CURRENT_DIR, '..');
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'db', 'migrations');
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'data', 'tasks.db');

function listMigrationFiles(migrationsDir) {
  return readdirSync(migrationsDir)
    .filter(name => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

export function runMigrations({
  dbPath = process.env.TASK_DB_PATH || DEFAULT_DB_PATH,
  migrationsDir = MIGRATIONS_DIR
} = {}) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const migrationFiles = listMigrationFiles(migrationsDir);
  const checkAppliedStmt = db.prepare('SELECT name FROM _migrations WHERE name = ?');
  const recordMigrationStmt = db.prepare('INSERT INTO _migrations(name, applied_at) VALUES (?, ?)');
  const applied = [];

  for (const fileName of migrationFiles) {
    if (checkAppliedStmt.get(fileName)) {
      continue;
    }

    const migrationPath = path.join(migrationsDir, fileName);
    const sql = readFileSync(migrationPath, 'utf8').trim();
    if (!sql) {
      continue;
    }

    db.exec('BEGIN');
    try {
      db.exec(sql);
      recordMigrationStmt.run(fileName, new Date().toISOString());
      db.exec('COMMIT');
      applied.push(fileName);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration "${fileName}" failed: ${error.message}`);
    }
  }

  db.close();
  return { dbPath, applied };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === CURRENT_FILE;
if (isCli) {
  const result = runMigrations();
  if (result.applied.length === 0) {
    console.log(`No pending migrations. Database: ${result.dbPath}`);
  } else {
    console.log(`Applied ${result.applied.length} migration(s) to ${result.dbPath}:`);
    for (const name of result.applied) {
      console.log(`- ${name}`);
    }
  }
}
