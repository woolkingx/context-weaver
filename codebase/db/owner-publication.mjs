import { FILE_BLOCK_SCHEMA_VERSION } from '../../common/db/ddl.mjs';
import { assertValid, validateCacheManifest, validateFileBlock } from '../../common/db/validate.mjs';
import { fileAddress } from './partition.mjs';
import { assertPayload, isText } from './payload.mjs';

// Atomic publication boundary of one cache database. It composes the FileBlocks,
// FileLedger, OwnerManifest, and GraphProjection targets inside the transaction
// capability owned by FileBlockStore, so a reader never observes a mixture of two
// generations. It holds no database handle of its own.
export class OwnerPublication {
  #transaction;

  #blocks;

  #ledger;

  #manifests;

  #projection;

  constructor({
    transaction, blocks, ledger, manifests, projection,
  }) {
    this.#transaction = transaction;
    this.#blocks = blocks;
    this.#ledger = ledger;
    this.#manifests = manifests;
    this.#projection = projection;
  }

  ingest({ blocks = [] } = {}) {
    assertPayload({
      target: 'OwnerPublication',
      method: 'ingest',
      errors: Array.isArray(blocks) ? [] : ['blocks: must be an array'],
    });
    const admitted = blocks.map((block) => ({
      ...block,
      file_path: block.file_path ?? block.filePath,
      schema_version: block.schema_version ?? FILE_BLOCK_SCHEMA_VERSION,
    }));
    assertValid(admitted, validateFileBlock, 'FileBlock');
    if (admitted.length === 0) return;
    this.#transaction(() => {
      const partitions = new Map(admitted.map((block) => [
        `${block.owner}\u0000${block.cache_key}`,
        { owner: block.owner, cacheKey: block.cache_key },
      ]));
      const existing = new Map([...partitions.values()]
        .flatMap((partition) => this.#blocks.signatures(partition))
        .map((row) => [
          `${row.owner}\u0000${row.cache_key}\u0000${row.root_id}\u0000${row.file_path}`,
          row,
        ]));
      const scopesByPartition = new Map();
      for (const block of admitted) {
        const key = `${block.owner}\u0000${block.cache_key}\u0000${block.root_id}\u0000${block.file_path}`;
        const previous = existing.get(key);
        if (previous
          && previous.fingerprint === block.fingerprint
          && previous.producer_generation === block.producer_generation
          && previous.schema_version === block.schema_version) continue;
        this.#blocks.put({
          row: {
            ...block, mtime_ms: block.mtime_ms ?? null, size: block.size ?? null, content_hash: block.content_hash ?? null,
          },
        });
        const scopesKey = `${block.owner}\u0000${block.cache_key}`;
        const scopes = scopesByPartition.get(scopesKey) ?? { owner: block.owner, cacheKey: block.cache_key, filePaths: [] };
        scopes.filePaths.push({ rootId: block.root_id, filePath: block.file_path });
        scopesByPartition.set(scopesKey, scopes);
      }
      this.#ledger.record({ blocks: admitted });
      for (const scopes of scopesByPartition.values()) {
        const mark = {
          owner: scopes.owner, cacheKey: scopes.cacheKey, scopes: scopes.filePaths, generation: admitted[0].producer_generation,
        };
        this.#ledger.projectionMark({ ...mark, status: 'projecting' });
        this.#projection.refresh(scopes);
        this.#ledger.projectionMark({ ...mark, status: 'ready' });
      }
    });
  }

  publish({
    owner, cacheKey = owner, blocks = [], manifest, blockPaths = null,
  }) {
    assertPayload({
      target: 'OwnerPublication',
      method: 'publish',
      errors: [
        ...(isText(owner) ? [] : ['owner: must be a non-empty string']),
        ...(isText(cacheKey) ? [] : ['cacheKey: must be a non-empty string']),
        ...(Array.isArray(blocks) ? [] : ['blocks: must be an array']),
        ...(blockPaths === null || Array.isArray(blockPaths) ? [] : ['blockPaths: must be null or an array']),
        ...validateCacheManifest(manifest, 'manifest'),
      ],
    });
    const rows = blocks.map((block) => ({
      ...block, owner, cache_key: cacheKey, schema_version: block.schema_version ?? FILE_BLOCK_SCHEMA_VERSION,
    }));
    assertValid(rows, validateFileBlock, 'FileBlock');
    return this.#transaction(() => {
      let removed = 0;
      const changedFiles = new Map();
      const existing = new Map(this.#blocks.signatures({ owner, cacheKey })
        .map((row) => [fileAddress(row.root_id, row.file_path), row]));
      for (const block of rows) {
        const key = fileAddress(block.root_id, block.file_path);
        const previous = existing.get(key);
        if (!previous
          || previous.fingerprint !== block.fingerprint
          || previous.producer_generation !== (block.producer_generation ?? manifest.producerGeneration)
          || previous.schema_version !== (block.schema_version ?? FILE_BLOCK_SCHEMA_VERSION)) {
          changedFiles.set(key, { rootId: block.root_id, filePath: block.file_path });
        }
      }
      const admitted = blockPaths === null ? null : new Set(
        (manifest.files?.length > 0
          ? manifest.files.map((file) => fileAddress(file.root_id, file.path))
          : blocks.map((block) => fileAddress(block.root_id, block.file_path ?? block.filePath))),
      );
      if (admitted) {
        for (const row of this.#blocks.addresses({ owner, cacheKey })) {
          if (!admitted.has(fileAddress(row.root_id, row.file_path))) {
            this.#blocks.remove({
              owner, cacheKey, rootId: row.root_id, filePath: row.file_path,
            });
            changedFiles.set(fileAddress(row.root_id, row.file_path), { rootId: row.root_id, filePath: row.file_path });
            removed += 1;
          }
        }
      }
      for (const block of blocks) {
        this.#blocks.put({
          row: {
            owner,
            cache_key: cacheKey,
            root_id: block.root_id,
            file_path: block.file_path ?? block.filePath,
            fingerprint: block.fingerprint,
            mtime_ms: block.mtime_ms ?? block.mtimeMs ?? null,
            size: block.size ?? null,
            content_hash: block.content_hash ?? block.contentHash ?? null,
            producer_generation: block.producer_generation ?? manifest.producerGeneration,
            schema_version: block.schema_version ?? FILE_BLOCK_SCHEMA_VERSION,
            value: block.value,
          },
        });
      }
      this.#ledger.syncMetadata({ owner, cacheKey, files: manifest.files ?? [] });
      this.#ledger.record({ blocks: rows });
      if (admitted) this.#ledger.prune({ owner, cacheKey });
      if (changedFiles.size > 0) {
        const scopes = [...changedFiles.values()];
        const mark = {
          owner, cacheKey, scopes, generation: manifest.producerGeneration,
        };
        this.#ledger.projectionMark({ ...mark, status: 'projecting' });
        if (existing.size === 0) this.#projection.rebuild({ owner, cacheKey });
        else this.#projection.refresh({ owner, cacheKey, filePaths: scopes });
        this.#ledger.projectionMark({ ...mark, status: 'ready' });
      }
      // Rebuilt input may contain only changed blocks. The manifest revision
      // set must describe the complete post-transaction partition, otherwise
      // an incremental publish can never become fresh after one-file edits.
      const revisionSet = this.#blocks.revisions({ owner, cacheKey });
      this.#manifests.commit({
        owner, cacheKey, manifest, revisionSet,
      });
      return { admitted: revisionSet.length, published: blocks.length, removed };
    });
  }

  markIncompatible({
    owner, cacheKey, rootId, files = [], error,
  } = {}) {
    const paths = [...new Set(files)].filter((value) => typeof value === 'string' && value.length > 0);
    if (!owner || !cacheKey || !rootId || paths.length === 0) return 0;
    return this.#transaction(() => {
      this.#ledger.markIncompatible({
        owner, cacheKey, rootId, paths, error,
      });
      for (const filePath of paths) {
        this.#blocks.remove({
          owner, cacheKey, rootId, filePath,
        });
      }
      this.#manifests.drop({ owner, cacheKey });
      this.#projection.refresh({ owner, cacheKey, filePaths: paths.map((filePath) => ({ rootId, filePath })) });
      return paths.length;
    });
  }

  drop({ owner, cacheKey = null } = {}) {
    assertPayload({
      target: 'OwnerPublication',
      method: 'drop',
      errors: [
        ...(isText(owner) ? [] : ['owner: must be a non-empty string']),
        ...(cacheKey === null || isText(cacheKey) ? [] : ['cacheKey: must be null or a non-empty string']),
      ],
    });
    this.#transaction(() => {
      this.#blocks.removeOwner({ owner, cacheKey });
      this.#ledger.removeOwner({ owner, cacheKey });
      this.#projection.drop({ owner, cacheKey });
      this.#manifests.drop({ owner, cacheKey });
    });
  }
}
