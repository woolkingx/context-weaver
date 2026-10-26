import { cacheKeyFor } from './cache-key.mjs';
import { FILE_BLOCK_SCHEMA_VERSION } from '../../common/db/ddl.mjs';

// The cache coordinator owns persistence only.  It consumes injected owner
// identity and an injected producer callable; it never imports or invokes a
// business definition's admission or build directly.
export class OwnerCacheCoordinator {
  constructor({
    name, producerGeneration = 'file', produce, fileBlockStore = null, auditLogger = null, progress = null, onReceipt = null,
  }) {
    if (!name) throw new TypeError('OwnerCacheCoordinator requires an owner name.');
    if (typeof produce !== 'function') throw new TypeError('OwnerCacheCoordinator requires a produce callable.');
    this.name = name;
    this.producerGeneration = producerGeneration;
    this.produce = produce;
    this.fileBlockStore = fileBlockStore;
    this.auditLogger = auditLogger;
    this.progress = progress;
    this.onReceipt = onReceipt;
  }

  async load({ root, input: admittedInput = null } = {}) {
    const started = performance.now();
    const { name } = this;
    const cacheKey = cacheKeyFor(name, root);
    this.auditLogger?.event('ctx.owner.load.start', { owner: name, root, cache_key: cacheKey });
    this.progress?.('owner.load.start', { owner: name, root, cache_key: cacheKey });

    let input;
    try {
      if (!admittedInput?.manifest) {
        throw Object.assign(new TypeError('Cache load requires admitted owner input.'), { code: 'OWNER_INPUT_REQUIRED' });
      }
      input = admittedInput;
    } catch (error) {
      this.#auditError(root, cacheKey, 'admit', error);
      throw error;
    }

    if (!this.fileBlockStore) {
      const built = await this.#build(root, input, null);
      this.#auditEnd(root, cacheKey, built.blocks, started, 'producer');
      this.#receipt('producer', cacheKey, built.blocks, built.metrics);
      return { blocks: built.blocks, blockPaths: built.blockPaths };
    }

    try {
      const freshness = this.fileBlockStore.manifests.freshness({
        owner: name, manifest: input.manifest, cacheKey,
      });
      if (freshness.fresh) {
        const count = freshness.fileBlockCount;
        this.#auditCount('ctx.cache.hit', root, cacheKey, count, started, 'cache');
        this.#auditCount('ctx.owner.load.end', root, cacheKey, count, started, 'cache');
        this.#receipt('fresh', cacheKey, [], {
          file_block_count: count,
          file_count: count,
          admitted: count,
          reused: count,
          rebuilt: 0,
          removed: 0,
          ready_in_db: true,
        });
        return {
          blocks: [], blockPaths: null, fileBlockCount: count, readyInDb: true,
        };
      }
    } catch (error) {
      this.#cacheError(root, cacheKey, 'read', error);
      this.auditLogger?.event('ctx.cache.miss', {
        owner: name, root, cache_key: cacheKey, reason: 'read-error',
      });
      const built = await this.#build(root, input, null);
      this.#auditEnd(root, cacheKey, built.blocks, started, 'fallback');
      this.#fallback(root, cacheKey, built.blocks, 'read');
      return { blocks: built.blocks, blockPaths: built.blockPaths };
    }

    this.auditLogger?.event('ctx.cache.miss', { owner: name, root, cache_key: cacheKey });
    const built = await this.#build(root, input, this.fileBlockStore);
    try {
      const publish = this.fileBlockStore.publication.publish({
        owner: name,
        cacheKey,
        manifest: input.manifest,
        blocks: built.publishBlocks,
        blockPaths: built.blockPaths,
      });
      this.#audit('ctx.cache.write', root, cacheKey, built.blocks, started, 'producer');
      this.#auditEnd(root, cacheKey, built.blocks, started, 'producer');
      this.#receipt('rebuilt', cacheKey, built.blocks, {
        ...built.metrics,
        ...publish,
        ready_in_db: true,
      });
      return {
        blocks: built.blocks,
        blockPaths: built.blockPaths,
        fileBlockCount: input.manifest.admittedFileCount,
        readyInDb: true,
      };
    } catch (error) {
      this.#cacheError(root, cacheKey, 'publish', error);
      this.#auditEnd(root, cacheKey, built.blocks, started, 'fallback');
      this.#fallback(root, cacheKey, built.blocks, 'publish');
      return { blocks: built.blocks, blockPaths: built.blockPaths };
    }
  }

  async status({ root, input: admittedInput = null } = {}) {
    const { name } = this;
    this.auditLogger?.event('ctx.owner.status.start', { owner: name, root });
    const cacheKey = cacheKeyFor(name, root);

    if (!admittedInput?.manifest) {
      throw Object.assign(new TypeError('Cache status requires admitted owner input.'), { code: 'OWNER_INPUT_REQUIRED' });
    }
    const input = admittedInput;

    try {
      if (!this.fileBlockStore) {
        const result = { owner: name, cache_key: cacheKey, state: 'missing' };
        this.auditLogger?.event('ctx.owner.status.end', result);
        return result;
      }
      const { manifests } = this.fileBlockStore;
      const stored = manifests.read({ owner: name, cacheKey });
      const summary = manifests.summary({ cacheKey }).find((row) => row.owner === name);
      const result = {
        owner: name,
        cache_key: cacheKey,
        state: !stored ? 'missing' : manifests.isFresh({ owner: name, manifest: input.manifest, cacheKey }) ? 'fresh' : 'stale',
        ...(summary ? { file_block_count: summary.file_block_count } : {}),
        admitted_files: input.manifest.admittedFileCount,
      };
      this.auditLogger?.event('ctx.owner.status.end', result);
      return result;
    } catch (error) {
      const result = {
        owner: name,
        cache_key: cacheKey,
        state: 'unavailable',
        error: errorFields(error),
        recovery: recoveryFor(error),
      };
      this.auditLogger?.event('ctx.owner.status.end', result);
      return result;
    }
  }

  async #build(root, input, fileBlockStore) {
    const result = await this.produce({
      root,
      input,
      auditLogger: this.auditLogger,
      readFileBlock: fileBlockStore
        ? (rootId, filePath, fingerprint) => fileBlockStore.blocks.get({
          owner: this.name,
          cacheKey: cacheKeyFor(this.name, root),
          rootId,
          filePath,
          fingerprint,
        })
        : () => null,
      readFileBlockMetadata: fileBlockStore
        ? (rootId, filePath) => fileBlockStore.blocks.meta({
          owner: this.name,
          cacheKey: cacheKeyFor(this.name, root),
          rootId,
          filePath,
        })
        : null,
    });
    const blocks = normalizeBlocks((result.blocks ?? []).map((file) => {
      const filePath = file.file_path ?? file.filePath ?? file.path;
      const manifestFile = (input.manifest.files ?? []).find((candidate) => candidate.root_id === file.root_id && candidate.path === filePath);
      if (!file.root_id) throw new Error(`FileBlock is missing root_id: ${this.name}/${filePath}`);
      if (!file.value || typeof file.value !== 'object') throw new Error(`FileBlock is missing owner value: ${this.name}/${filePath}`);
      return {
        ...file, file_path: filePath, fingerprint: file.fingerprint ?? manifestFile?.sha256 ?? `${this.producerGeneration}:${filePath}`, mtime_ms: file.mtime_ms ?? file.mtimeMs ?? manifestFile?.mtimeMs, size: file.size ?? manifestFile?.size, content_hash: file.content_hash ?? file.contentHash ?? manifestFile?.sha256, value: file.value,
      };
    }), {
      owner: this.name,
      cacheKey: cacheKeyFor(this.name, root),
      producerGeneration: this.producerGeneration,
    });
    const publishBlocks = normalizeBlocks((result.publishBlocks ?? result.blocks ?? []).map((file) => {
      const filePath = file.file_path ?? file.filePath ?? file.path;
      const manifestFile = (input.manifest.files ?? []).find((candidate) => candidate.root_id === file.root_id && candidate.path === filePath);
      if (!file.root_id) throw new Error(`FileBlock is missing root_id: ${this.name}/${filePath}`);
      if (!file.value || typeof file.value !== 'object') throw new Error(`FileBlock is missing owner value: ${this.name}/${filePath}`);
      return {
        ...file, file_path: filePath, fingerprint: file.fingerprint ?? manifestFile?.sha256 ?? `${this.producerGeneration}:${filePath}`, mtime_ms: file.mtime_ms ?? file.mtimeMs ?? manifestFile?.mtimeMs, size: file.size ?? manifestFile?.size, content_hash: file.content_hash ?? file.contentHash ?? manifestFile?.sha256, value: file.value,
      };
    }), {
      owner: this.name,
      cacheKey: cacheKeyFor(this.name, root),
      producerGeneration: this.producerGeneration,
    });
    return {
      blocks,
      publishBlocks,
      metrics: result.cacheStats ?? {
        admitted: blocks.length, reused: 0, rebuilt: blocks.length, removed: 0,
      },
      blockPaths: result.blockPaths ?? null,
    };
  }

  #audit(event, root, cacheKey, blocks, started, source) {
    this.auditLogger?.event(event, {
      owner: this.name,
      root,
      cache_key: cacheKey,
      source,
      file_block_count: blocks.length,
      duration_ms: Math.round(performance.now() - started),
    });
    this.progress?.(event.replace(/^ctx\./, ''), { owner: this.name, source, duration_ms: Math.round(performance.now() - started) });
  }

  #auditEnd(root, cacheKey, blocks, started, source) {
    this.#audit('ctx.owner.load.end', root, cacheKey, blocks, started, source);
  }

  #auditCount(event, root, cacheKey, count, started, source) {
    this.auditLogger?.event(event, {
      owner: this.name,
      root,
      cache_key: cacheKey,
      source,
      file_block_count: count,
      duration_ms: Math.round(performance.now() - started),
    });
    this.progress?.(event.replace(/^ctx\./, ''), {
      owner: this.name, source, file_block_count: count, duration_ms: Math.round(performance.now() - started),
    });
  }

  #fallback(root, cacheKey, blocks, operation) {
    this.auditLogger?.event('ctx.cache.fallback', {
      owner: this.name,
      root,
      cache_key: cacheKey,
      operation,
      file_block_count: blocks.length,
    });
    this.#receipt('fallback', cacheKey, blocks, { operation });
  }

  #receipt(state, cacheKey, blocks, extra = {}) {
    this.onReceipt?.({
      owner: this.name,
      cache_key: cacheKey,
      state,
      file_block_count: blocks.length,
      file_count: blocks.length,
      ...extra,
    });
  }

  #auditError(root, cacheKey, operation, error) {
    const fields = {
      level: 'error',
      owner: this.name,
      root,
      cache_key: cacheKey,
      operation,
      error: errorFields(error),
    };
    this.auditLogger?.event('ctx.owner.load.error', fields);
    this.progress?.('owner.load.error', {
      owner: this.name,
      root,
      cache_key: cacheKey,
      operation,
      state: 'error',
      error_code: fields.error.code,
    });
  }

  #cacheError(root, cacheKey, operation, error) {
    const fields = {
      level: 'warn',
      owner: this.name,
      root,
      cache_key: cacheKey,
      operation,
      error: errorFields(error),
    };
    this.auditLogger?.event('ctx.cache.error', fields);
    this.progress?.('cache.error', {
      owner: this.name,
      root,
      cache_key: cacheKey,
      operation,
      state: 'fallback',
      error_code: fields.error.code,
    });
  }
}

function normalizeBlocks(blocks, { owner, cacheKey, producerGeneration }) {
  return blocks.map((block) => ({
    owner,
    cache_key: cacheKey,
    root_id: block.root_id,
    file_path: block.file_path ?? block.filePath,
    fingerprint: block.fingerprint,
    mtime_ms: block.mtime_ms ?? block.mtimeMs ?? null,
    size: block.size ?? null,
    content_hash: block.content_hash ?? block.contentHash ?? null,
    producer_generation: block.producer_generation ?? producerGeneration,
    schema_version: block.schema_version ?? FILE_BLOCK_SCHEMA_VERSION,
    value: block.value,
  }));
}

function errorFields(error) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    message: error?.message ?? String(error),
  };
}

export function recoveryFor(error) {
  if (error?.code === 'CACHE_SCHEMA_OLD') {
    return 'Run ctx cache build to rebuild the cache with the current FileBlock schema.';
  }
  if (error?.code === 'GIT_UNAVAILABLE') {
    return 'Install Git, then rerun ctx cache status or ctx cache build.';
  }
  return 'Inspect the reported owner error, correct the input or cache path, then retry.';
}
