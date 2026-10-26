import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { assertReadOnlyStatement, installReadOnlyAuthorizer } from '../../common/db/sql-guard.mjs';
import { CacheSchema } from './cache-schema.mjs';
import { FileBlocks } from './file-blocks.mjs';
import { FileLedger } from './file-ledger.mjs';
import { GraphProjection } from './graph-projection.mjs';
import { OwnerManifest } from './owner-manifest.mjs';
import { OwnerPublication } from './owner-publication.mjs';
import { TokenWeights } from './token-weights.mjs';

// Canonical Store owner and composition root of one cache database. It owns the
// SQLite connection, its transaction and read-snapshot lifecycle, and close.
// Table access lives in the composed targets, which consumers reach by
// `store.<target>.method(payload)`; the raw database handle is never exposed.
export class FileBlockStore {
  #db = null;

  #jsonbSupported = false;

  #readSnapshotOpen = false;

  #targets = null;

  open({ dbPath } = {}) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec('PRAGMA busy_timeout=5000');
    this.#db.exec('PRAGMA journal_mode=WAL');
    ({ jsonbSupported: this.#jsonbSupported } = CacheSchema.ensure({ db: this.#db, dbPath }));
    const db = this.#db;
    const jsonbSupported = this.#jsonbSupported;
    const transaction = (work) => this.#transaction(work);
    const blocks = new FileBlocks({ db, jsonbSupported });
    const ledger = new FileLedger({ db, jsonbSupported });
    const projection = new GraphProjection({ db });
    const manifests = new OwnerManifest({ db, jsonbSupported, blocks });
    this.#targets = {
      blocks,
      ledger,
      manifests,
      publication: new OwnerPublication({
        transaction, blocks, ledger, manifests, projection,
      }),
      tokenWeights: new TokenWeights({ db, transaction }),
    };
    return this;
  }

  get blocks() {
    this.#ensureOpen();
    return this.#targets.blocks;
  }

  get ledger() {
    this.#ensureOpen();
    return this.#targets.ledger;
  }

  get manifests() {
    this.#ensureOpen();
    return this.#targets.manifests;
  }

  get publication() {
    this.#ensureOpen();
    return this.#targets.publication;
  }

  get tokenWeights() {
    this.#ensureOpen();
    return this.#targets.tokenWeights;
  }

  supportsJsonb() {
    this.#ensureOpen();
    return this.#jsonbSupported;
  }

  query({ sql, params = [] } = {}) {
    this.#ensureOpen();
    return this.#db.prepare(sql).all(...params);
  }

  exec({ sql } = {}) {
    this.#ensureOpen();
    this.#db.exec(sql);
  }

  readOnlyQuery({ sql, params = [], blockedTables = [] } = {}) {
    this.#ensureOpen();
    assertReadOnlyStatement(sql);
    installReadOnlyAuthorizer(this.#db, { blockedTables });
    try {
      return this.query({ sql, params });
    } finally {
      this.#db.setAuthorizer(() => 0);
    }
  }

  beginReadSnapshot() {
    if (!this.#db) throw new Error('FileBlockStore is not open.');
    if (this.#readSnapshotOpen) return;
    try {
      this.#db.exec('BEGIN DEFERRED');
      this.#db.prepare('SELECT COUNT(*) FROM file_blocks').get();
      this.#readSnapshotOpen = true;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  endReadSnapshot() {
    if (!this.#db || !this.#readSnapshotOpen) return;
    this.#db.exec('ROLLBACK');
    this.#readSnapshotOpen = false;
  }

  close() {
    this.endReadSnapshot();
    this.#db?.close();
    this.#db = null;
    this.#targets = null;
  }

  #transaction(work) {
    this.#ensureOpen();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch { /* preserve the source error */ }
      throw error;
    }
  }

  #ensureOpen() {
    if (!this.#db) throw new Error('FileBlockStore is not open.');
  }
}
