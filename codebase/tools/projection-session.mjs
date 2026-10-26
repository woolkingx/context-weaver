import path from 'node:path';

import { cacheKeyFor } from '../db/cache-key.mjs';
import { resolveDbPath } from '../db/root-store.mjs';
import { TokenMatrix } from '../data-service/token-matrix.mjs';
import { FileOwner } from '../../common/owners/files-owner.mjs';
import { admitOwners } from './owner-admission.mjs';
import { markIncompatibleOwner } from './owner-diagnostics.mjs';

// One request-scoped projection: admission, cache read-through, and a single
// read snapshot over one in-memory SQLite projection.
export class ProjectionSession {
  static async open(options) {
    const session = new ProjectionSession(options);
    try {
      await session.open();
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  }

  constructor({
    toolsApi, root, owners, config, auditLogger = null, progress = null, filePathsQuery = null,
  } = {}) {
    this.toolsApi = toolsApi;
    this.root = root;
    this.owners = owners;
    this.config = config;
    this.auditLogger = auditLogger;
    this.progress = progress;
    this.filePathsQuery = filePathsQuery;
    this.admittedInputs = null;
    this.admissionErrors = new Map();
    this.loadErrors = new Map();
    this.requestedOwners = [...owners];
    this.db = null;
    this.store = null;
    this.cacheSession = null;
    this.tokenMatrix = null;
    this.closed = false;
  }

  async open() {
    // Dynamic imports avoid a ContextDb -> ToolsApi module cycle.  ToolsApi is
    // still the owner of the composed runtime object and its lifetime.
    const [{ ContextDb }, { FileBlockStore }, { CacheFoundationSession }] = await Promise.all([
      import('../db/context-db.mjs'),
      import('../db/file-block-store.mjs'),
      import('../db/cache-foundation.mjs'),
    ]);
    this.progress?.('session.open', { owners: this.owners.join(',') });
    this.progress?.('admission.start', { owners: this.owners.join(','), root: this.root });
    await FileOwner.forRoot(this.root);
    const admission = await admitOwners({ root: this.root, owners: this.owners, progress: this.progress });
    this.admittedInputs = admission.inputs;
    this.admissionErrors = admission.errors;
    this.owners = this.owners.filter((owner) => !this.admissionErrors.has(owner));
    this.progress?.('admission.end', {
      owners: this.requestedOwners.join(','),
      active_owners: this.owners.join(','),
      root: this.root,
      error_count: this.admissionErrors.size,
    });
    this.store = new FileBlockStore().open({ dbPath: resolveDbPath({ config: this.config, root: this.root }) });
    for (const [owner, error] of this.admissionErrors) {
      markIncompatibleOwner({
        fileBlockStore: this.store,
        owner,
        root: this.root,
        error,
      });
    }
    this.cacheSession = new CacheFoundationSession({
      root: this.root,
      config: this.config,
      fileBlockStore: this.store,
      auditLogger: this.auditLogger,
      toolsApi: this.toolsApi,
    });
    this.tokenMatrix = new TokenMatrix({
      file: this.config.paths.tokenMatrixFile,
      legacyFile: this.config.paths.legacyTokenMatrixFile,
    });
    this.progress?.('cache.read', { owners: this.owners.join(','), source: 'after-admission' });
    this.progress?.('projection.build.start', { owners: this.owners.join(',') });
    const buildStarted = performance.now();
    this.auditLogger?.event('ctx.build.start', {
      root: this.root,
      owners: this.owners,
      file_block_cache_enabled: true,
    });
    let result;
    try {
      result = await this.toolsApi.loadFileBlocks({
        root: this.root,
        owners: this.owners,
        fileBlockStore: this.store,
        filePaths: null,
        admittedInputs: this.admittedInputs,
        admissionErrors: this.admissionErrors,
        auditLogger: this.auditLogger,
        progress: this.progress,
      });
      const fileBlockCount = result.receipts.reduce(
        (count, receipt) => count + (receipt.file_count ?? receipt.file_block_count ?? 0),
        0,
      );
      this.auditLogger?.event('ctx.build.end', {
        root: this.root,
        owners: this.owners,
        file_block_count: fileBlockCount,
        duration_ms: Math.round(performance.now() - buildStarted),
      });
    } catch (error) {
      this.auditLogger?.event('ctx.build.error', {
        level: 'error',
        root: this.root,
        owners: this.owners,
        duration_ms: Math.round(performance.now() - buildStarted),
        error,
      });
      throw error;
    }
    this.loadErrors = new Map((result.loadErrors ?? []).map(({ owner, error }) => [owner, error]));
    for (const [owner, error] of this.loadErrors) {
      markIncompatibleOwner({
        fileBlockStore: this.store,
        owner,
        root: this.root,
        error,
      });
    }
    this.owners = this.owners.filter((owner) => !this.loadErrors.has(owner));
    // The projection is a SQL pre-join over the cache FileBlock base: bind it
    // only after admission and load isolation have selected active owners.
    this.db = new ContextDb({
      toolsApi: this.toolsApi,
      fileBlockStore: this.store,
      scope: {
        owners: this.owners,
        cacheKeys: this.owners.map((owner) => cacheKeyFor(owner, this.root)),
      },
    });
    this.db.attachProjection({
      owners: this.owners,
      cacheKeys: this.owners.map((owner) => cacheKeyFor(owner, this.root)),
      result,
      tokenMatrixPath: this.config.paths.tokenMatrixFile,
      tokenMatrixLegacyPath: this.config.paths.legacyTokenMatrixFile,
    });
    this.cacheSession.addReceiptFromBuild(this.db.lastBuildReceipts);
    for (const owner of this.owners) {
      this.cacheSession.remember({
        owner,
        root: this.root,
        result: {
          blocks: this.db.lastBuildBlocks.filter((block) => block.owner === owner),
          receipts: this.db.lastBuildReceipts.filter((receipt) => receipt.owner === owner),
        },
      });
    }
    // Bind one SQLite read snapshot after owner publication and before the
    // session becomes queryable. Later cache publication cannot mix generations
    // into this projection session.
    this.store.beginReadSnapshot();
    this.progress?.('projection.build', { file_block_count: this.db.lastBuildReceipts.reduce((count, receipt) => count + (receipt.file_count ?? receipt.file_block_count ?? 0), 0) });
  }

  query({ sql, params = [] } = {}) {
    this.assertOpen();
    this.progress?.('query', { operation: 'sql' });
    return this.db.query({ sql, params });
  }

  sql({ sql, params = [] } = {}) {
    this.assertOpen();
    this.progress?.('query', { operation: 'sql' });
    return this.db.runUserSql({ sql, params });
  }

  result({ rows, withCacheReceipt = false } = {}) {
    this.assertOpen();
    this.progress?.('project', { row_count: rows.length });
    return withCacheReceipt ? { rows, cache: this.cacheSession.summary() } : rows;
  }

  cacheReceipt() {
    this.assertOpen();
    return this.cacheSession.summary();
  }

  async sourceOwnerFor(root = this.root) {
    this.assertOpen();
    const candidate = path.resolve(root);
    const declaredRoots = [
      this.root,
      ...(this.config?.values?.globalSkillRoots ?? [])
        .map((source) => source?.absolutePath)
        .filter(Boolean),
    ].map((source) => path.resolve(source));
    if (!declaredRoots.some((declaredRoot) => isWithinRoot(candidate, declaredRoot))) {
      const error = new Error(`Source root is not admitted by the Unified Data Service session: ${root}`);
      error.code = 'SOURCE_ROOT_NOT_ADMITTED';
      throw error;
    }
    return FileOwner.forRoot(candidate);
  }

  tokenMatrixFor() {
    this.assertOpen();
    return this.tokenMatrix;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db?.close();
    } finally {
      this.cacheSession?.close();
      this.store?.close();
      this.tokenMatrix = null;
      this.progress?.('session.close', { owners: this.owners.join(',') });
    }
  }

  assertOpen() {
    if (this.closed || !this.db) throw new Error('ToolsApi projection session is closed.');
  }
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
