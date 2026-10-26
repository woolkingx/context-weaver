import { fileAddress, ownerScope } from './partition.mjs';

// cache_manifests and cache_releases of one cache database: the persisted digest
// of an owner input together with its FileBlock revision set, and the freshness
// predicate that compares it with the current input.
export class OwnerManifest {
  #db;

  #encoder;

  #blocks;

  constructor({ db, jsonbSupported, blocks }) {
    this.#db = db;
    this.#encoder = jsonbSupported ? 'jsonb' : 'json';
    this.#blocks = blocks;
  }

  read({ owner, cacheKey = owner }) {
    const row = this.#db.prepare(
      'SELECT owner, cache_key, fingerprint, producer_generation, admitted_file_count, policy_fingerprint, json(file_revision_set) AS file_revision_set FROM cache_manifests WHERE owner = ? AND cache_key = ?',
    ).get(owner, cacheKey);
    return row ? { ...row, file_revision_set: JSON.parse(row.file_revision_set) } : null;
  }

  freshness({ owner, manifest, cacheKey = owner }) {
    const stored = this.read({ owner, cacheKey });
    if (!stored || stored.fingerprint !== manifest.fingerprint || stored.producer_generation !== manifest.producerGeneration) return { fresh: false, fileBlockCount: null };
    const expected = Number(manifest.admittedFileCount ?? 0);
    if (stored.admitted_file_count !== expected || stored.file_revision_set.length !== expected) return { fresh: false, fileBlockCount: null };
    const rows = this.#blocks.integrity({ owner, cacheKey });
    if (rows.length !== expected) return { fresh: false, fileBlockCount: rows.length };
    const revisionByPath = new Map(stored.file_revision_set.map((revision) => [fileAddress(revision.root_id, revision.file_path), revision.fingerprint]));
    if (revisionByPath.size !== rows.length || rows.some((row) => revisionByPath.get(fileAddress(row.root_id, row.file_path)) !== row.fingerprint)) return { fresh: false, fileBlockCount: rows.length };
    const fileByPath = new Map((manifest.files ?? []).map((file) => [fileAddress(file.root_id, file.path), file]));
    if (fileByPath.size > 0 && (fileByPath.size !== rows.length || rows.some((row) => {
      const file = fileByPath.get(fileAddress(row.root_id, row.file_path));
      return !file || (file.sha256 && file.sha256 !== row.content_hash);
    }))) return { fresh: false, fileBlockCount: rows.length };
    return {
      fresh: rows.every((row) => row.fingerprint && row.content_hash && row.value_valid && row.owner_shape_valid),
      fileBlockCount: rows.length,
    };
  }

  isFresh(payload = {}) {
    return this.freshness(payload).fresh;
  }

  summary({ cacheKey = null } = {}) {
    const where = cacheKey === null ? '' : ' WHERE cache_key = ?';
    return this.#db.prepare(`SELECT owner, cache_key, admitted_file_count AS file_block_count FROM cache_manifests${where} ORDER BY owner`)
      .all(...(cacheKey === null ? [] : [cacheKey]));
  }

  commit({
    owner, cacheKey, manifest, revisionSet,
  }) {
    const createdAt = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO cache_manifests (owner, cache_key, fingerprint, producer_generation, admitted_file_count, policy_fingerprint, file_revision_set, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ${this.#encoder}(?), ?)
      ON CONFLICT(owner, cache_key) DO UPDATE SET fingerprint = excluded.fingerprint,
        producer_generation = excluded.producer_generation, admitted_file_count = excluded.admitted_file_count,
        policy_fingerprint = excluded.policy_fingerprint, file_revision_set = excluded.file_revision_set,
        created_at = excluded.created_at
    `).run(
      owner,
      cacheKey,
      manifest.fingerprint,
      manifest.producerGeneration,
      manifest.admittedFileCount,
      manifest.policyFingerprint,
      JSON.stringify(revisionSet),
      createdAt,
    );
    this.#db.prepare(`
      INSERT OR IGNORE INTO cache_releases (owner, cache_key, release_id, snapshot_fingerprint, created_at, file_revision_set)
      VALUES (?, ?, ?, ?, ?, ${this.#encoder}( ?))
    `).run(owner, cacheKey, manifest.fingerprint, manifest.fingerprint, createdAt, JSON.stringify(revisionSet));
  }

  drop({ owner, cacheKey = null }) {
    const { where, params } = ownerScope({ owner, cacheKey });
    this.#db.prepare(`DELETE FROM cache_manifests WHERE ${where}`).run(...params);
    this.#db.prepare(`DELETE FROM cache_releases WHERE ${where}`).run(...params);
  }
}
