import { ownerScope } from './partition.mjs';

// file_blocks table of one cache database: complete JSONB FileBlock revisions.
// Methods never open a transaction; FileBlockStore owns the connection and
// runs them inside its transaction when atomicity is required.
export class FileBlocks {
  #db;

  #encoder;

  #putStatement = null;

  #removeStatement = null;

  constructor({ db, jsonbSupported }) {
    this.#db = db;
    this.#encoder = jsonbSupported ? 'jsonb' : 'json';
  }

  put({ row }) {
    this.#putStatement ??= this.#db.prepare(`
      INSERT INTO file_blocks (owner, cache_key, root_id, file_path, fingerprint, mtime_ms, size, content_hash, producer_generation, schema_version, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${this.#encoder}(?))
      ON CONFLICT(owner, cache_key, root_id, file_path) DO UPDATE SET
        fingerprint = excluded.fingerprint, mtime_ms = excluded.mtime_ms, size = excluded.size,
        content_hash = excluded.content_hash, producer_generation = excluded.producer_generation, schema_version = excluded.schema_version, value = excluded.value
    `);
    this.#putStatement.run(
      row.owner,
      row.cache_key,
      row.root_id,
      row.file_path,
      row.fingerprint,
      row.mtime_ms,
      row.size,
      row.content_hash,
      row.producer_generation,
      row.schema_version,
      JSON.stringify(row.value),
    );
  }

  remove({
    owner, cacheKey, rootId, filePath,
  }) {
    this.#removeStatement ??= this.#db.prepare('DELETE FROM file_blocks WHERE owner = ? AND cache_key = ? AND root_id = ? AND file_path = ?');
    this.#removeStatement.run(owner, cacheKey, rootId, filePath);
  }

  get({
    owner, cacheKey, rootId, filePath, fingerprint, producerGeneration = null,
  }) {
    const generationClause = producerGeneration === null ? '' : ' AND producer_generation = ?';
    const row = this.#db.prepare(
      `SELECT owner, cache_key, root_id, file_path, fingerprint, mtime_ms, size, content_hash, producer_generation, schema_version, json(value) AS value FROM file_blocks WHERE owner = ? AND cache_key = ? AND root_id = ? AND file_path = ? AND fingerprint = ?${generationClause}`,
    ).get(owner, cacheKey, rootId, filePath, fingerprint, ...(producerGeneration === null ? [] : [producerGeneration]));
    if (!row) return null;
    return { ...row, value: JSON.parse(row.value) };
  }

  meta({
    owner, cacheKey, rootId, filePath,
  }) {
    return this.#db.prepare(
      'SELECT owner, cache_key, root_id, file_path, fingerprint, mtime_ms, size, content_hash, producer_generation, schema_version FROM file_blocks WHERE owner = ? AND cache_key = ? AND root_id = ? AND file_path = ?',
    ).get(owner, cacheKey, rootId, filePath) ?? null;
  }

  removeOwner({ owner, cacheKey = null }) {
    const { where, params } = ownerScope({ owner, cacheKey });
    this.#db.prepare(`DELETE FROM file_blocks WHERE ${where}`).run(...params);
  }

  // Integrity facts of every compatible block in one owner partition: the
  // inputs of the manifest freshness predicate.
  integrity({ owner, cacheKey }) {
    return this.#db.prepare(
      `SELECT f.root_id, f.file_path, f.fingerprint, f.content_hash,
              json_valid(b.value, 6) AS value_valid,
              CASE WHEN ? = 'rules'
                THEN (json_type(b.value, '$.path') = 'text'
                  AND json_type(b.value, '$.content') = 'text'
                  AND json_type(b.value, '$.sections') = 'object')
                ELSE 1 END AS owner_shape_valid
       FROM file_blocks AS b
       JOIN files AS f ON f.owner = b.owner AND f.cache_key = b.cache_key
         AND f.root_id = b.root_id AND f.file_path = b.file_path AND f.incompatible = 0
       WHERE b.owner = ? AND b.cache_key = ? ORDER BY b.root_id, b.file_path`,
    ).all(owner, owner, cacheKey);
  }

  // Stored revision identity, for the whole database or one owner partition.
  signatures({ owner = null, cacheKey = null } = {}) {
    const where = owner === null ? '' : ' WHERE owner = ? AND cache_key = ?';
    return this.#db.prepare(
      `SELECT owner, cache_key, root_id, file_path, fingerprint, producer_generation, schema_version FROM file_blocks${where}`,
    ).all(...(owner === null ? [] : [owner, cacheKey]));
  }

  addresses({ owner, cacheKey }) {
    return this.#db.prepare('SELECT root_id, file_path FROM file_blocks WHERE owner = ? AND cache_key = ?')
      .all(owner, cacheKey);
  }

  revisions({ owner, cacheKey }) {
    return this.#db.prepare(
      'SELECT root_id, file_path, fingerprint FROM file_blocks WHERE owner = ? AND cache_key = ? ORDER BY root_id, file_path',
    ).all(owner, cacheKey);
  }
}
