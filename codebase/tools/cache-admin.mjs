import { cacheKeyFor } from '../db/cache-key.mjs';
import { OwnerCacheCoordinator } from '../db/persistent-owner-runner.mjs';
import { resolveDbPath } from '../db/root-store.mjs';
import { FileOwner } from '../../common/owners/files-owner.mjs';
import { PERSISTENT_OWNER_DEFINITIONS } from '../owners/persistent-owners.mjs';
import { admitOwners, assertRootAndOwners } from './owner-admission.mjs';
import { incompatibleStatus, markIncompatibleOwner, ownerErrors } from './owner-diagnostics.mjs';

// Cache lifecycle operations for one root: report freshness, build, and clear.
export class CacheAdmin {
  constructor({ toolsApi, fileBlockRouter }) {
    this.toolsApi = toolsApi;
    this.fileBlockRouter = fileBlockRouter;
  }

  async status({ config = null, fileBlockStore = null, ...options } = {}) {
    assertRootAndOwners({ root: options.root, owners: options.owners, scope: 'cache' });
    if (fileBlockStore) return this.#ownerStatus(options, fileBlockStore);
    const { FileBlockStore } = await import('../db/file-block-store.mjs');
    const store = new FileBlockStore().open({ dbPath: resolveDbPath({ config, root: options.root }) });
    try {
      return await this.#ownerStatus(options, store);
    } finally {
      store.close();
    }
  }

  async build({
    config, root, owners, auditLogger = null, progress = null,
  } = {}) {
    assertRootAndOwners({ root, owners, scope: 'cache' });
    const session = await this.toolsApi.openProjectionSession({
      root, owners, config, auditLogger, progress,
    });
    try {
      return {
        receipts: session.db.lastBuildReceipts,
        cache: session.cacheReceipt(),
        errors: ownerErrors({ admissionErrors: session.admissionErrors, loadErrors: session.loadErrors }),
      };
    } finally {
      session.close();
    }
  }

  static async clear({ config, root, owners } = {}) {
    assertRootAndOwners({ root, owners, scope: 'cache' });
    const [{ FileBlockStore }, { CacheSchema }] = await Promise.all([
      import('../db/file-block-store.mjs'),
      import('../db/cache-schema.mjs'),
    ]);
    const dbPath = resolveDbPath({ config, root });
    let store;
    try {
      store = new FileBlockStore().open({ dbPath });
    } catch (error) {
      if (error?.code !== 'CACHE_SCHEMA_OLD') throw error;
      CacheSchema.quarantine({ dbPath });
      store = new FileBlockStore().open({ dbPath });
    }
    try {
      for (const owner of owners) store.publication.drop({ owner, cacheKey: cacheKeyFor(owner, root) });
      return { owners, root };
    } finally {
      store.close();
    }
  }

  async #ownerStatus(options, fileBlockStore) {
    const {
      root, owners, auditLogger = null, progress = null,
    } = options;
    const { inputs: admittedInputs, errors: admissionErrors } = await admitOwners({ root, owners, progress });
    for (const [owner, error] of admissionErrors) {
      markIncompatibleOwner({
        fileBlockStore, owner, root, error,
      });
    }
    const requests = owners.map((owner) => async () => {
      const admissionError = admissionErrors.get(owner);
      if (admissionError) {
        return incompatibleStatus({
          owner, root, fileBlockStore, error: admissionError,
        });
      }
      const definition = PERSISTENT_OWNER_DEFINITIONS.get(owner);
      if (!definition) throw new Error(`Unknown persistent owner: ${owner}`);
      auditLogger?.event('ctx.owner.status.start', { owner, root });
      progress?.('owner.status.start', { owner });
      const result = await new OwnerCacheCoordinator({
        name: definition.name,
        producerGeneration: definition.producerGeneration,
        produce: (payload) => definition.build(payload),
        fileBlockStore,
        auditLogger,
        progress,
      }).status({ root, input: admittedInputs.get(owner) });
      auditLogger?.event('ctx.owner.status.end', result);
      progress?.('owner.status.end', result);
      return result;
    });
    return FileOwner.withSession(() => this.fileBlockRouter.status({ ...options, requests }));
  }
}
