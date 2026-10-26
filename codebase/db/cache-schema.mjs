import { existsSync, renameSync } from 'node:fs';

import { buildPersistentDdl, DERIVED_PROJECTION_SCHEMA_VERSION } from '../../common/db/ddl.mjs';
import { ErrorObject } from '../../common/lib/error-object.mjs';
import { GraphProjection } from './graph-projection.mjs';

// Schema lifecycle of one cache database: create, validate, migrate, and
// quarantine an incompatible file. The connection itself belongs to FileBlockStore.
export class CacheSchema {
  static ensure({ db, dbPath }) {
    rejectRetiredSchema(db, dbPath);
    try {
      db.exec(buildPersistentDdl());
      assertFileBlockSchema(db, dbPath);
      backfillFileRecords(db);
      ensureDerivedProjection(db);
    } catch (error) {
      if (error instanceof ErrorObject) throw error;
      throw new ErrorObject({
        code: 'DB_SCHEMA_ERROR',
        message: `Failed to initialize database: ${error.message}`,
        cause: error,
        context: { action: 'schema_creation', dbPath },
      });
    }
    return { jsonbSupported: supportsJsonb(db) };
  }

  static quarantine({ dbPath }) {
    const retired = `${dbPath}.retired-${Date.now()}`;
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${dbPath}${suffix}`;
      if (existsSync(source)) renameSync(source, `${retired}${suffix}`);
    }
    return retired;
  }
}

function backfillFileRecords(db) {
  db.exec(`
    INSERT OR IGNORE INTO files (
      owner, cache_key, root_id, file_path, fingerprint, mtime_ms, size,
      content_hash, status, incompatible, error_code, error_message, error_context, updated_at
    )
    SELECT owner, cache_key, root_id, file_path, fingerprint, mtime_ms, size,
           content_hash, 'ready', 0, NULL, NULL, NULL, datetime('now')
    FROM file_blocks
  `);
}

function supportsJsonb(db) {
  try {
    db.prepare('SELECT jsonb(?)').get('{}');
    return true;
  } catch {
    return false;
  }
}

function ensureDerivedProjection(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= DERIVED_PROJECTION_SCHEMA_VERSION) return;
  // v4→v5 migration: DDL already contains projection_generation/node_status/edge_status columns.
  // We only update user_version; no ALTER TABLE needed.
  db.exec('BEGIN');
  try {
    if (version < 4) {
      const [{ count }] = db.prepare('SELECT COUNT(*) AS count FROM file_blocks').all();
      if (count > 0) GraphProjection.rebuildAll(db);
    }
    db.exec(`PRAGMA user_version = ${DERIVED_PROJECTION_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function rejectRetiredSchema(db, dbPath) {
  const retired = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'persistent_nodes', 'persistent_edges', 'persistent_file_blocks',
      'persistent_owner_manifests', 'persistent_releases', 'owner_snapshots',
      'graph_nodes', 'graph_edges'
    ) ORDER BY name
  `).all().map((row) => row.name);
  const fileBlockColumns = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_blocks'").get()
    ? new Set(db.prepare('PRAGMA table_info(file_blocks)').all().map((row) => row.name))
    : null;
  const fileColumns = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'files'").get()
    ? new Set(db.prepare('PRAGMA table_info(files)').all().map((row) => row.name))
    : null;
  const missingProjectionColumns = fileColumns
    ? ['projection_generation', 'node_status', 'edge_status'].filter((column) => !fileColumns.has(column))
    : [];
  if (retired.length === 0 && (!fileBlockColumns || fileBlockColumns.has('root_id')) && missingProjectionColumns.length === 0) return;
  const reason = retired.length > 0
    ? `uses the retired Graph schema (${retired.join(', ')})`
    : missingProjectionColumns.length > 0
      ? `has an incompatible projection-mark schema (missing ${missingProjectionColumns.join(', ')})`
      : 'has a pre-root_id FileBlock schema';
  throw new ErrorObject({
    code: 'CACHE_SCHEMA_OLD',
    message: `Cache database ${dbPath} ${reason}; run ctx cache build to rebuild it.`,
    context: { dbPath, reason },
  });
}

function assertFileBlockSchema(db, dbPath) {
  const columns = new Set(db.prepare('PRAGMA table_info(file_blocks)').all().map((row) => row.name));
  const required = ['owner', 'cache_key', 'root_id', 'file_path', 'fingerprint', 'mtime_ms', 'size', 'content_hash', 'producer_generation', 'schema_version', 'value'];
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length === 0) return;
  throw new ErrorObject({
    code: 'CACHE_SCHEMA_OLD',
    message: `Cache database ${dbPath} has an incompatible FileBlock schema (missing ${missing.join(', ')}); run ctx cache build to rebuild it.`,
    context: { dbPath, missing },
  });
}
