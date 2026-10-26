/**
 * ContextDb - read-only SQL queries over FileBlock-derived node/edge rows.
 * files owns source-file identity/lifecycle; file_blocks owns retained JSONB;
 * node_rows and edge_rows are derived acceleration.
 */
import { ToolsApi } from '../tools/tools-api.mjs';
import { assertValid, validateTokenWeight } from '../../common/db/validate.mjs';
import { TokenMatrix } from '../data-service/token-matrix.mjs';
import { RELATION_PROJECTION_VIEWS } from './relation-projection.mjs';
import { GraphProjection } from './graph-projection.mjs';

export class ContextDb {
  #jsonbSupported = false;

  #fileBlockStore = null;

  #ownsFileBlockStore = false;

  #scope = null;

  #open = false;

  lastBuildReceipts = [];

  lastBuildBlocks = [];

  lastBuildFileBlockCount = 0;

  constructor({
    toolsApi = null, fileBlockStore = null, scope = null, ownsFileBlockStore = false,
  } = {}) {
    const requiredMethods = ['query', 'exec', 'supportsJsonb', 'readOnlyQuery'];
    if (!fileBlockStore
      || requiredMethods.some((method) => typeof fileBlockStore[method] !== 'function')
      || typeof fileBlockStore.publication?.ingest !== 'function'
      || typeof fileBlockStore.tokenWeights?.replace !== 'function') {
      throw new TypeError('ContextDb requires an injected FileBlockStore.');
    }
    this.toolsApi = toolsApi ?? new ToolsApi();
    this.#fileBlockStore = fileBlockStore;
    this.#ownsFileBlockStore = ownsFileBlockStore;
    this.#scope = scope;
  }

  open() {
    if (this.#open) return this;
    this.#jsonbSupported = this.#fileBlockStore.supportsJsonb();
    this.#open = true;
    return this;
  }

  query({ sql, params = [] } = {}) {
    this._ensureOpen();
    return this.#fileBlockStore.query({ sql, params });
  }

  runUserSql({ sql, params = [] } = {}) {
    this._ensureOpen();
    return this.#fileBlockStore.readOnlyQuery({
      sql,
      params,
      blockedTables: ['cache_manifests', 'cache_releases', 'files', 'file_blocks', 'node_rows', 'edge_rows'],
    });
  }

  insertFileBlocks({ blocks = [] } = {}) {
    this._ensureOpen();
    this.#fileBlockStore.publication.ingest({ blocks });
    this.#installProjectionViews();
  }

  replaceTokenWeights({ weights = [] } = {}) {
    this._ensureOpen();
    this.#fileBlockStore.tokenWeights.replace({ weights });
  }

  attachProjection({
    owners, cacheKeys: requestedCacheKeys, result, tokenMatrixPath, tokenMatrixLegacyPath,
  }) {
    this.open();
    this.lastBuildReceipts = result.receipts ?? [];
    this.lastBuildBlocks = result.blocks ?? [];
    this.lastBuildFileBlockCount = this.lastBuildReceipts.reduce(
      (count, receipt) => count + (receipt.file_count ?? receipt.file_block_count ?? 0),
      0,
    );
    const cacheKeys = requestedCacheKeys ?? owners.map((owner) => {
      const receipt = (result.receipts ?? []).find((item) => item.owner === owner);
      const block = (result.blocks ?? []).find((item) => item.owner === owner);
      return receipt?.cache_key ?? block?.cache_key ?? owner;
    });
    this.#installBoundProjection({
      ...result,
      owners,
      cacheKeys,
    });
    const weights = new TokenMatrix({ file: tokenMatrixPath, legacyFile: tokenMatrixLegacyPath }).rows();
    assertValid(weights, validateTokenWeight, 'token_weight');
    this.replaceTokenWeights({ weights });
    return this;
  }

  async build({
    root, owners, fileBlockStore = null, auditLogger = null, progress = null, tokenMatrixPath, tokenMatrixLegacyPath, filePaths = null, admittedInputs = null,
  }) {
    const started = performance.now();
    auditLogger?.event('ctx.build.start', { root, owners, file_block_cache_enabled: fileBlockStore !== null });
    this.open();
    try {
      const result = await this.toolsApi.loadFileBlocks({
        root, owners, fileBlockStore, auditLogger, progress, filePaths, admittedInputs,
      });
      this.attachProjection({
        owners,
        cacheKeys: this.#scope?.cacheKeys,
        result,
        tokenMatrixPath,
        tokenMatrixLegacyPath,
      });
      auditLogger?.event('ctx.build.end', {
        root, owners, file_block_count: this.lastBuildFileBlockCount, duration_ms: Math.round(performance.now() - started),
      });
      return this;
    } catch (error) {
      auditLogger?.event('ctx.build.error', {
        level: 'error', root, owners, duration_ms: Math.round(performance.now() - started), error,
      });
      throw error;
    }
  }

  tables() {
    return this.query({ sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" }).map((row) => row.name);
  }

  columns({ table } = {}) {
    return this.query({ sql: `PRAGMA table_info(${table})` });
  }

  close() {
    if (!this.#open) return;
    if (this.#ownsFileBlockStore) this.#fileBlockStore.close();
    this.#open = false;
  }

  #installBoundProjection(result) {
    const { owners, cacheKeys } = result;
    const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const blockCounts = new Map();
    for (const block of result.blocks) {
      const key = `${block.owner}\u0000${block.cache_key}`;
      blockCounts.set(key, (blockCounts.get(key) ?? 0) + 1);
    }
    const needsPersistentWrite = [...blockCounts.entries()].some(([key, expected]) => {
      const [owner, cacheKey] = key.split('\u0000');
      const [{ count: actual }] = this.#fileBlockStore.query({
        sql: 'SELECT COUNT(*) AS count FROM file_blocks WHERE owner = ? AND cache_key = ?',
        params: [owner, cacheKey],
      });
      return actual < expected;
    });
    if (needsPersistentWrite) this.insertFileBlocks({ blocks: result.blocks });
    const blockOwners = new Set(result.blocks.map((block) => block.owner));
    const readyOwners = new Set(result.receipts.filter((receipt) => receipt.ready_in_db).map((receipt) => receipt.owner));
    const scope = owners.flatMap((owner, index) => (
      blockOwners.has(owner) || readyOwners.has(owner)
        ? [`(owner = ${literal(owner)} AND cache_key = ${literal(cacheKeys[index])})`]
        : []
    )).join(' OR ') || '0 = 1';
    this.#dropProjectionViews();
    // Bind raw SQL to the same scope as the named product views. Otherwise an
    // agent can pass --owners X but read another owner's persistent rows.
    this.#fileBlockStore.exec({ sql: `CREATE TEMP VIEW ctx_projection_blocks AS SELECT * FROM main.file_blocks WHERE ${scope}` });
    this.#fileBlockStore.exec({ sql: `CREATE TEMP VIEW ctx_node_rows AS SELECT * FROM main.node_rows WHERE ${scope}` });
    this.#fileBlockStore.exec({ sql: `CREATE TEMP VIEW ctx_edge_rows AS SELECT * FROM main.edge_rows WHERE ${scope}` });
    for (const table of ['cache_manifests', 'cache_releases', 'files', 'file_blocks', 'node_rows', 'edge_rows']) {
      this.#fileBlockStore.exec({ sql: `CREATE TEMP VIEW ${table} AS SELECT * FROM main.${table} WHERE ${scope}` });
    }
    const temp = (sql) => sql.replaceAll('CREATE VIEW', 'CREATE TEMP VIEW');
    this.#fileBlockStore.exec({ sql: temp(fileBlockProjectionViews(this.#jsonbSupported, 'ctx_projection_blocks')) });
    for (const sql of GraphProjection.views('ctx_node_rows', 'ctx_edge_rows')) this.#fileBlockStore.exec({ sql: temp(sql) });
    for (const sql of Object.values(RELATION_PROJECTION_VIEWS)) this.#fileBlockStore.exec({ sql: temp(sql) });
  }

  #installProjectionViews() {
    this.#dropProjectionViews();
    this.#fileBlockStore.exec({ sql: fileBlockProjectionViews(this.#jsonbSupported) });
    for (const sql of GraphProjection.views()) this.#fileBlockStore.exec({ sql });
    for (const sql of Object.values(RELATION_PROJECTION_VIEWS)) this.#fileBlockStore.exec({ sql });
  }

  #dropProjectionViews() {
    for (const name of ['ctx_projection_blocks', 'ctx_node_rows', 'ctx_edge_rows', 'cache_manifests', 'cache_releases', 'files', 'file_blocks', 'node_rows', 'edge_rows']) {
      this.#fileBlockStore.exec({ sql: `DROP VIEW IF EXISTS temp.${name}` });
    }
    for (const name of ['node_view', 'edge_view', 'ast_node_view', 'ast_edge_view', 'ast_relation_view', 'architecture_view', 'workflow_view', 'sequence_view', 'dataflow_view', 'lifecycle_view', 'nodes', 'edges', 'graph_nodes', 'graph_edges', 'file_ast', 'file_projection']) {
      this.#fileBlockStore.exec({ sql: `DROP VIEW IF EXISTS ${name}` });
    }
  }

  _ensureOpen() {
    if (!this.#open) this.open();
  }
}

function fileBlockProjectionViews(jsonbSupported, baseTable = 'file_blocks') {
  const ast = jsonbSupported ? "jsonb(json_extract(value, '$.ast'))" : "json_extract(value, '$.ast')";
  return `
  CREATE VIEW file_ast AS
    SELECT root_id, file_path,
           COALESCE(json_extract(value, '$.ast.format'), 'ctx.ast.v1') AS format,
           COALESCE(json_extract(value, '$.ast.language'), 'unknown') AS language,
           COALESCE(json_extract(value, '$.ast.parser_version'), json_extract(value, '$.ast.version'), 'unknown') AS parser_version,
           ${ast} AS ast
    FROM ${baseTable}
    WHERE json_type(value, '$.ast') = 'object';

  CREATE VIEW file_projection AS
    SELECT b.owner AS module, b.owner, b.cache_key, b.root_id, b.file_path,
           b.fingerprint AS file_block_fingerprint,
           m.projection_generation, m.node_status, m.edge_status,
           m.status AS projection_status, m.error_code AS projection_error,
           m.updated_at AS projection_updated_at,
           (SELECT COUNT(*) FROM node_rows n WHERE n.owner = b.owner AND n.cache_key = b.cache_key AND n.root_id = b.root_id AND n.file_path = b.file_path) AS node_count,
           (SELECT COUNT(*) FROM edge_rows e WHERE e.owner = b.owner AND e.cache_key = b.cache_key AND e.root_id = b.root_id AND e.file_path = b.file_path) AS edge_count
    FROM ${baseTable} b
    LEFT JOIN files m
      ON m.owner = b.owner AND m.cache_key = b.cache_key AND m.root_id = b.root_id AND m.file_path = b.file_path;
`;
}

export const FILE_BLOCK_COLUMNS = ['owner', 'cache_key', 'root_id', 'file_path', 'fingerprint', 'mtime_ms', 'size', 'content_hash', 'producer_generation', 'schema_version', 'value'];
