import { ownerScope } from './partition.mjs';

// files table of one cache database: source-file identity, lifecycle status,
// projection marks, and incompatible-file diagnostics. Like FileBlocks, methods
// run inside the transaction opened by FileBlockStore.
export class FileLedger {
  #db;

  #encoder;

  constructor({ db, jsonbSupported }) {
    this.#db = db;
    this.#encoder = jsonbSupported ? 'jsonb' : 'json';
  }

  record({ blocks }) {
    const statement = this.#db.prepare(`
      INSERT INTO files (
        owner, cache_key, root_id, file_path, fingerprint, mtime_ms, size,
        content_hash, status, incompatible, error_code, error_message, error_context, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', 0, NULL, NULL, NULL, ?)
      ON CONFLICT(owner, cache_key, root_id, file_path) DO UPDATE SET
        fingerprint = excluded.fingerprint, mtime_ms = excluded.mtime_ms, size = excluded.size,
        content_hash = excluded.content_hash, status = 'ready', incompatible = 0,
        error_code = NULL, error_message = NULL, error_context = NULL, updated_at = excluded.updated_at
    `);
    const updatedAt = new Date().toISOString();
    for (const block of blocks) {
      statement.run(
        block.owner,
        block.cache_key,
        block.root_id,
        block.file_path ?? block.filePath,
        block.fingerprint,
        block.mtime_ms ?? block.mtimeMs ?? null,
        block.size ?? null,
        block.content_hash ?? block.contentHash ?? null,
        updatedAt,
      );
    }
  }

  projectionMark({
    owner, cacheKey, scopes = [], generation, status,
  }) {
    const statement = this.#db.prepare(`
      INSERT INTO files (
        owner, cache_key, root_id, file_path, fingerprint,
        projection_generation, node_status, edge_status, status, error_code, updated_at
      )
      SELECT ?, ?, f.root_id, f.file_path, f.fingerprint, ?, ?, ?, ?, NULL, ?
      FROM files f
      WHERE f.owner = ? AND f.cache_key = ? AND f.root_id = ? AND f.file_path = ?
      ON CONFLICT(owner, cache_key, root_id, file_path) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        projection_generation = excluded.projection_generation,
        node_status = excluded.node_status, edge_status = excluded.edge_status,
        status = excluded.status, error_code = excluded.error_code, updated_at = excluded.updated_at
    `);
    const now = new Date().toISOString();
    for (const scope of scopes) {
      statement.run(
        owner,
        cacheKey,
        generation,
        status,
        status,
        status,
        now,
        owner,
        cacheKey,
        scope.rootId,
        scope.filePath,
      );
    }
  }

  syncMetadata({ owner, cacheKey, files = [] }) {
    const update = this.#db.prepare(`
      UPDATE files
      SET mtime_ms = ?, size = ?, content_hash = ?, updated_at = ?
      WHERE owner = ? AND cache_key = ? AND root_id = ? AND file_path = ?
    `);
    const updatedAt = new Date().toISOString();
    for (const file of files) {
      update.run(
        file.mtimeMs ?? null,
        file.size ?? null,
        file.sha256 ?? null,
        updatedAt,
        owner,
        cacheKey,
        file.root_id,
        file.path,
      );
    }
  }

  markIncompatible({
    owner, cacheKey, rootId, paths, error,
  }) {
    const code = error?.code ?? 'FILE_FORMAT_INCOMPATIBLE';
    const message = error?.message ?? 'Source file format is incompatible with this owner.';
    const context = visibleErrorContext(error?.context ?? {});
    const mark = this.#db.prepare(`
      INSERT INTO files (
        owner, cache_key, root_id, file_path, fingerprint, mtime_ms, size,
        content_hash, status, incompatible, error_code, error_message, error_context, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'incompatible', 1, ?, ?, ${this.#encoder}(?), ?)
      ON CONFLICT(owner, cache_key, root_id, file_path) DO UPDATE SET
        fingerprint = NULL, mtime_ms = NULL, size = NULL, content_hash = NULL,
        status = 'incompatible', incompatible = 1, error_code = excluded.error_code,
        error_message = excluded.error_message, error_context = excluded.error_context,
        updated_at = excluded.updated_at
    `);
    const updatedAt = new Date().toISOString();
    for (const filePath of paths) {
      mark.run(owner, cacheKey, rootId, filePath, code, message, JSON.stringify(context), updatedAt);
    }
  }

  incompatible({ owner, cacheKey }) {
    return this.#db.prepare(`
      SELECT root_id, file_path, error_code, error_message, json(error_context) AS error_context
      FROM files
      WHERE owner = ? AND cache_key = ? AND incompatible = 1
      ORDER BY root_id, file_path
    `).all(owner, cacheKey).map((row) => ({
      ...row,
      error_context: row.error_context ? JSON.parse(row.error_context) : null,
    }));
  }

  removeOwner({ owner, cacheKey = null }) {
    const { where, params } = ownerScope({ owner, cacheKey });
    this.#db.prepare(`DELETE FROM files WHERE ${where}`).run(...params);
  }

  // Ledger rows whose FileBlock no longer exists.
  prune({ owner, cacheKey }) {
    this.#db.prepare(`
      DELETE FROM files
      WHERE owner = ? AND cache_key = ?
        AND NOT EXISTS (
          SELECT 1 FROM file_blocks
          WHERE file_blocks.owner = files.owner
            AND file_blocks.cache_key = files.cache_key
            AND file_blocks.root_id = files.root_id
            AND file_blocks.file_path = files.file_path
        )
    `).run(owner, cacheKey);
  }
}

function visibleErrorContext(context) {
  return Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'stack' && key !== 'cause'));
}
