import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'os';
import path from 'path';

import { runMigrations } from './migrate-tasks-db.js';

function verifyPriorityColumn(db) {
  const columns = db.prepare('PRAGMA table_info(tasks)').all();
  const priorityColumn = columns.find(column => column.name === 'priority');

  assert.ok(priorityColumn, 'tasks.priority column exists');
  assert.equal(priorityColumn.notnull, 1, 'tasks.priority is NOT NULL');
  assert.match(String(priorityColumn.dflt_value), /medium/, 'tasks.priority default is medium');
}

function verifyDefaultValue(db) {
  db.exec("INSERT INTO tasks(title) VALUES ('first')");
  const row = db.prepare('SELECT priority FROM tasks WHERE title = ?').get('first');
  assert.equal(row.priority, 'medium', 'default priority is medium');
}

function verifyValueConstraint(db) {
  db.exec("INSERT INTO tasks(title, priority) VALUES ('high item', 'high')");
  const highRow = db.prepare('SELECT priority FROM tasks WHERE title = ?').get('high item');
  assert.equal(highRow.priority, 'high', 'explicit high priority is stored');

  let raisedError;
  try {
    db.exec("INSERT INTO tasks(title, priority) VALUES ('invalid item', 'urgent')");
  } catch (error) {
    raisedError = error;
  }

  assert.ok(raisedError, 'invalid priority value raises an error');
}

function verifyMigrationIdempotency(dbPath) {
  const rerun = runMigrations({ dbPath });
  assert.equal(rerun.applied.length, 0, 'running migrations twice keeps state stable');
}

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'proxy-toggle-us001-'));
const dbPath = path.join(tempDir, 'tasks.db');

try {
  const firstRun = runMigrations({ dbPath });
  assert.equal(firstRun.applied.length, 2, 'two migrations are applied on first run');

  const db = new DatabaseSync(dbPath);
  verifyPriorityColumn(db);
  verifyDefaultValue(db);
  verifyValueConstraint(db);
  db.close();

  verifyMigrationIdempotency(dbPath);
  console.log('US-001 verification passed');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
