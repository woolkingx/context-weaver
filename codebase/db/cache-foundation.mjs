import { FileBlockStore } from './file-block-store.mjs';
import { resolveDbPath } from './root-store.mjs';
import { ErrorObject } from '../../common/lib/error-object.mjs';

// Shared acceleration foundation below the four semantic File/Cache pairs.
// It owns one root-scoped store; semantic owners own payload production.
export class CacheFoundationSession {
  #store;

  #ownsStore;

  #openedAt = null;

  #closedAt = null;

  #receipts = new Map();

  #loaded = new Map();

  constructor({
    root, config, fileBlockStore = null, auditLogger = null, toolsApi = null,
  } = {}) {
    this.root = root;
    this.config = config;
    this.auditLogger = auditLogger;
    this.toolsApi = toolsApi;
    this.#store = fileBlockStore;
    this.#ownsStore = !this.#store;
    this.#openedAt = performance.now();
  }

  get store() {
    return this.#store;
  }

  open() {
    if (this.#closedAt !== null) {
      throw new ErrorObject({ code: 'CACHE_SESSION_CLOSED', message: 'Cache foundation session is closed.' });
    }
    if (this.#store) return this;
    this.#store = new FileBlockStore().open({ dbPath: resolveDbPath({ config: this.config, root: this.root }) });
    return this;
  }

  async run(callback) {
    this.open();
    try {
      return await callback(this.#store, this);
    } finally {
      this.close();
    }
  }

  async load({ owner, root = this.root } = {}) {
    this.open();
    const key = `${owner}\\0${root}`;
    if (this.#loaded.has(key)) return this.#loaded.get(key);
    const { ToolsApi } = await import('../tools/tools-api.mjs');
    this.toolsApi ??= new ToolsApi({});
    // Retain the in-flight promise as well as its result: concurrent consumers
    // in this request must not initiate a second admission/build.
    if (!this.#loaded.has(key)) {
      const pending = this.toolsApi.loadFileBlocks({
        root, owners: [owner], fileBlockStore: this.#store, auditLogger: this.auditLogger,
      }).then((result) => {
        if (this.#closedAt !== null) {
          throw new ErrorObject({ code: 'CACHE_SESSION_CLOSED', message: 'Cache foundation session is closed.' });
        }
        this.addReceiptFromBuild(result.receipts);
        return result;
      }).catch((error) => {
        this.#loaded.delete(key); throw error;
      });
      this.#loaded.set(key, pending);
    }
    return this.#loaded.get(key);
  }

  addReceipt(receipt) {
    if (!receipt?.owner) return;
    this.#receipts.set(receipt.owner, {
      owner: receipt.owner,
      state: receipt.state ?? 'unknown',
      ...((receipt.file_count ?? receipt.file_block_count) == null ? {} : { fileCount: receipt.file_count ?? receipt.file_block_count }),
    });
  }

  addReceiptFromBuild(receipts = []) {
    for (const receipt of receipts) this.addReceipt(receipt);
  }

  remember({ owner, root = this.root, result } = {}) {
    this.#loaded.set(`${owner}\\0${root}`, result);
  }

  summary() {
    const owners = [...this.#receipts.values()].filter((receipt) => receipt.state !== 'producer').sort((left, right) => left.owner.localeCompare(right.owner));
    const counts = {
      fresh: 0, rebuilt: 0, fallback: 0, unavailable: 0, unknown: 0,
    };
    for (const receipt of owners) counts[receipt.state] = (counts[receipt.state] ?? 0) + 1;
    return {
      object: 'CacheReceipt',
      root: this.root,
      owners,
      counts,
      elapsedMs: this.#openedAt == null ? 0 : Math.max(0, Math.round((this.#closedAt ?? performance.now()) - this.#openedAt)),
      contract: 'latest FileBlock cache state; source evidence remains live',
    };
  }

  close() {
    if (this.#closedAt !== null) return;
    this.#closedAt = performance.now();
    try {
      if (this.#ownsStore) this.#store?.close();
    } finally {
      this.#store = null; this.#loaded.clear();
    }
  }
}

export async function withCacheFoundation({
  root, config, fileBlockStore = null, cacheSession = null, callback,
}) {
  if (cacheSession) return callback(cacheSession.store ?? fileBlockStore, cacheSession);
  const session = new CacheFoundationSession({ root, config, fileBlockStore });
  return session.run(callback);
}
