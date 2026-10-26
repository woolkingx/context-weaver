// FileBlock-derived node and edge rows. The tables are acceleration only;
// files owns source-file status; file_blocks retains complete compatible JSONB.
import path from 'node:path';

import { ownerScope } from './partition.mjs';
import { assertPayload, isText } from './payload.mjs';

const PROJECTION_FUNCTIONS = new WeakSet();
const LOCAL_MODULE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];

// node_rows and edge_rows of one cache database. Methods run inside the
// transaction opened by FileBlockStore; the projection never commits on its own.
export class GraphProjection {
  #db;

  constructor({ db }) {
    this.#db = db;
  }

  // Schema lifecycle helper: rebuild entire graph projection for a database
  static rebuildAll(db) {
    GraphProjection.#rebuildGraphProjection(db);
  }

  // Schema lifecycle helper: return view DDL statements
  static views(nodeTable = 'node_rows', edgeTable = 'edge_rows') {
    return GraphProjection.#graphProjectionViews(nodeTable, edgeTable);
  }

  // Connection-scoped path helper for the read-only SQL projection. It performs
  // only path arithmetic; whether a candidate is admitted stays an SQL join over
  // node_rows, so no JS graph or FileBlock hydration is introduced.
  static #registerProjectionFunctions(db) {
    if (PROJECTION_FUNCTIONS.has(db)) return;
    db.function('ctx_module_candidates', (sourcePath, moduleName) => {
      if (typeof sourcePath !== 'string' || typeof moduleName !== 'string' || !moduleName.startsWith('.')) return '[]';
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), moduleName));
      const candidates = [base];
      if (!path.posix.extname(base)) {
        for (const extension of LOCAL_MODULE_EXTENSIONS) candidates.push(`${base}${extension}`);
        for (const extension of LOCAL_MODULE_EXTENSIONS) candidates.push(path.posix.join(base, `index${extension}`));
      }
      return JSON.stringify([...new Set(candidates)]);
    });
    PROJECTION_FUNCTIONS.add(db);
  }

  static #normalizeEndpoint(expression) {
    return `CASE WHEN instr(${expression}, '#') > 0 THEN substr(${expression}, 1, instr(${expression}, '#') - 1) ELSE ${expression} END`;
  }

  static #compositeNodeKey(owner, cacheKey, rootId, generation, filePath, nodeId) {
    return `json_array(${owner}, ${cacheKey}, ${rootId}, ${generation}, ${filePath}, ${nodeId})`;
  }

  static #nodeRowsSql(baseTable, predicate) {
    const astNodeId = GraphProjection.#normalizeEndpoint("json_extract(node_item.value, '$.name')");
    const astNodes = `
    SELECT b.owner, b.cache_key, b.root_id, b.file_path, b.fingerprint, b.producer_generation,
           ${astNodeId} AS node_id,
           json_extract(node_item.value, '$.name') AS raw_node_id,
           json_extract(node_item.value, '$.structure.kind') AS node_kind,
           node_item.fullkey AS json_path,
           ${GraphProjection.#compositeNodeKey('b.owner', 'b.cache_key', 'b.root_id', 'b.producer_generation', 'b.file_path', astNodeId)} AS node_key,
           json_extract(node_item.value, '$.name') AS name,
           json_extract(node_item.value, '$.structure') AS structure,
           json_extract(node_item.value, '$.behavior') AS behavior
    FROM ${baseTable} AS b
    CROSS JOIN json_each(b.value, '$.ast.nodes') AS node_item
    WHERE ${predicate} AND json_type(b.value, '$.ast.nodes') = 'array'`;
    const semanticNodes = `
    SELECT b.owner, b.cache_key, b.root_id, b.file_path, b.fingerprint, b.producer_generation,
           'ctx.rule.' || b.root_id || '::' || json_extract(b.value, '$.path') AS node_id,
           json_extract(b.value, '$.path') AS raw_node_id,
           'rule' AS node_kind, '$.path' AS json_path,
           ${GraphProjection.#compositeNodeKey('b.owner', 'b.cache_key', 'b.root_id', 'b.producer_generation', 'b.file_path', "'ctx.rule.' || b.root_id || '::' || json_extract(b.value, '$.path')")} AS node_key,
           'ctx.rule.' || b.root_id || '::' || json_extract(b.value, '$.path') AS name,
           json_object('kind', 'rule', 'root_id', b.root_id, 'path', json_extract(b.value, '$.path'), 'content', json_extract(b.value, '$.content')) AS structure,
           json_object('sections', json_extract(b.value, '$.sections')) AS behavior
    FROM ${baseTable} AS b
    WHERE ${predicate}
      AND json_extract(b.value, '$.path') IS NOT NULL
      AND json_extract(b.value, '$.name') IS NULL
      AND json_extract(b.value, '$.scope') IS NULL
    UNION ALL
    SELECT b.owner, b.cache_key, b.root_id, b.file_path, b.fingerprint, b.producer_generation,
           'ctx.skill.' || b.root_id || '::' || json_extract(b.value, '$.path') AS node_id,
           json_extract(b.value, '$.path') AS raw_node_id,
           'skill' AS node_kind, '$.path' AS json_path,
           ${GraphProjection.#compositeNodeKey('b.owner', 'b.cache_key', 'b.root_id', 'b.producer_generation', 'b.file_path', "'ctx.skill.' || b.root_id || '::' || json_extract(b.value, '$.path')")} AS node_key,
           'ctx.skill.' || b.root_id || '::' || json_extract(b.value, '$.path') AS name,
           json_object('kind', 'skill', 'root_id', b.root_id, 'path', json_extract(b.value, '$.path'), 'scope', json_extract(b.value, '$.scope'), 'content', json_extract(b.value, '$.content')) AS structure,
           json_object('sections', json_extract(b.value, '$.sections')) AS behavior
    FROM ${baseTable} AS b
    WHERE ${predicate}
      AND json_extract(b.value, '$.scope') IS NOT NULL
      AND json_extract(b.value, '$.path') IS NOT NULL`;
    return `${astNodes}\nUNION ALL\n${semanticNodes}`;
  }

  static #rawEdgesSql(baseTable, predicate) {
    return `
    SELECT b.owner, b.cache_key, b.root_id, b.file_path, b.fingerprint, b.producer_generation,
           ${GraphProjection.#normalizeEndpoint("json_extract(edge_item.value, '$.frompath')")} AS source_id,
           ${GraphProjection.#normalizeEndpoint("json_extract(edge_item.value, '$.topath')")} AS target_id,
           json_extract(edge_item.value, '$.frompath') AS source_path,
           json_extract(edge_item.value, '$.topath') AS target_path,
           json_extract(edge_item.value, '$.kind') AS edge_kind,
           edge_item.fullkey AS json_path
    FROM ${baseTable} AS b
    CROSS JOIN json_each(b.value, '$.ast.edges') AS edge_item
    WHERE ${predicate} AND json_type(b.value, '$.ast.edges') = 'array'`;
  }

  // `predicate` is a function from a table alias to the SQL scope on that alias,
  // so the same scope can be applied to file_blocks and node_rows without
  // rewriting SQL text (a text rewrite would also corrupt file-name literals).
  static #graphNodeInsertSql({ baseTable = 'file_blocks', predicate = () => '1 = 1' } = {}) {
    return `INSERT INTO node_rows (
    owner, cache_key, root_id, file_path, fingerprint, producer_generation,
    node_id, raw_node_id, node_kind, json_path, node_key, name, structure, behavior
  ) ${GraphProjection.#nodeRowsSql(baseTable, predicate('b'))}`;
  }

  static #graphEdgeInsertSql({ baseTable = 'file_blocks', predicate = () => '1 = 1' } = {}) {
    const rawEdges = GraphProjection.#rawEdgesSql(baseTable, predicate('b'));
    return `INSERT INTO edge_rows (
    edge_key, owner, cache_key, root_id, file_path, fingerprint, producer_generation,
    edge_ordinal, source_id, target_id, source_path, target_path, edge_kind, json_path,
    source_node_key, resolution_status, resolution_reason, target_node_key, target_file_path
  )
  WITH module_targets AS (
    SELECT module_node.owner, module_node.cache_key, module_node.root_id, module_node.producer_generation,
           module_node.file_path, module_node.name AS module_node_name,
           file_node.file_path AS target_file_path
    FROM node_rows AS module_node
    CROSS JOIN json_each(ctx_module_candidates(
      module_node.file_path,
      substr(json_extract(module_node.structure, '$.displayName'), 8)
    )) AS candidate
    CROSS JOIN node_rows AS file_node
      ON file_node.owner = module_node.owner AND file_node.cache_key = module_node.cache_key AND file_node.root_id = module_node.root_id
     AND file_node.producer_generation = module_node.producer_generation
     AND file_node.node_kind = 'file' AND file_node.file_path = candidate.value
    WHERE ${predicate('module_node')}
      AND module_node.node_kind = 'external_module'
      AND json_extract(module_node.structure, '$.displayName') LIKE 'module:%'
  ), resolved_edges AS (
    SELECT raw.owner, raw.cache_key, raw.root_id, raw.file_path, raw.fingerprint, raw.producer_generation,
           raw.source_id, raw.source_path, raw.edge_kind, raw.json_path,
           CASE WHEN raw.edge_kind = 'imports' AND mt.target_file_path IS NOT NULL
                THEN 'codebase:' || mt.target_file_path
                ELSE raw.target_id END AS target_id,
           CASE WHEN raw.edge_kind = 'imports' AND mt.target_file_path IS NOT NULL
                THEN 'codebase:' || mt.target_file_path || '#structure'
                ELSE raw.target_path END AS target_path
    FROM (${rawEdges}) AS raw
    LEFT JOIN module_targets AS mt
      ON mt.owner = raw.owner AND mt.cache_key = raw.cache_key AND mt.root_id = raw.root_id
     AND mt.producer_generation = raw.producer_generation AND mt.file_path = raw.file_path
     AND mt.module_node_name = raw.target_id
  ), raw_edges AS (
    SELECT json_array(owner, cache_key, root_id, file_path, json_path, source_path, target_path, edge_kind) AS edge_key,
           owner, cache_key, root_id, file_path, fingerprint, producer_generation,
           ROW_NUMBER() OVER (PARTITION BY owner, cache_key, root_id, file_path ORDER BY json_path, source_path, target_path, edge_kind) AS edge_ordinal,
           source_id, target_id, source_path, target_path, edge_kind, json_path
    FROM resolved_edges
  ), source_matches AS (
    SELECT r.edge_key, COUNT(n.node_key) AS source_count, MAX(n.node_key) AS source_node_key
    FROM raw_edges r
    LEFT JOIN node_rows n ON n.owner = r.owner AND n.cache_key = r.cache_key AND n.root_id = r.root_id
      AND n.producer_generation = r.producer_generation AND n.file_path = r.file_path AND n.node_id = r.source_id
    GROUP BY r.edge_key
  ), same_file_targets AS (
    SELECT r.edge_key, COUNT(n.node_key) AS same_file_target_count, MAX(n.node_key) AS same_file_target_key
    FROM raw_edges r
    LEFT JOIN node_rows n ON n.owner = r.owner AND n.cache_key = r.cache_key AND n.root_id = r.root_id
      AND n.producer_generation = r.producer_generation AND n.file_path = r.file_path AND n.node_id = r.target_id
    GROUP BY r.edge_key
  ), scope_targets AS (
    SELECT r.edge_key, COUNT(n.node_key) AS scope_target_count, MAX(n.node_key) AS scope_target_key,
           MAX(n.file_path) AS scope_target_file_path
    FROM raw_edges r
    LEFT JOIN node_rows n ON n.owner = r.owner AND n.cache_key = r.cache_key AND n.root_id = r.root_id
      AND n.producer_generation = r.producer_generation AND n.node_id = r.target_id
    GROUP BY r.edge_key
  )
  SELECT r.edge_key, r.owner, r.cache_key, r.root_id, r.file_path, r.fingerprint, r.producer_generation,
         r.edge_ordinal, r.source_id, r.target_id, r.source_path, r.target_path, r.edge_kind, r.json_path,
         CASE WHEN s.source_count = 1 THEN s.source_node_key END AS source_node_key,
         CASE WHEN s.source_count = 0 THEN 'unresolved'
              WHEN s.source_count > 1 THEN 'ambiguous'
              WHEN t.same_file_target_count = 1 OR (t.same_file_target_count = 0 AND c.scope_target_count = 1) THEN 'resolved'
              WHEN t.same_file_target_count > 1 OR c.scope_target_count > 1 THEN 'ambiguous'
              ELSE 'unresolved' END AS resolution_status,
         CASE WHEN s.source_count = 0 THEN 'source_not_found'
              WHEN s.source_count > 1 THEN 'source_ambiguous'
              WHEN t.same_file_target_count > 1 THEN 'target_ambiguous_in_source_file'
              WHEN t.same_file_target_count = 0 AND c.scope_target_count > 1 THEN 'target_ambiguous_in_scope'
              WHEN t.same_file_target_count = 0 AND c.scope_target_count = 0 THEN 'target_not_found' END AS resolution_reason,
         CASE WHEN t.same_file_target_count = 1 THEN t.same_file_target_key
              WHEN t.same_file_target_count = 0 AND c.scope_target_count = 1 THEN c.scope_target_key END AS target_node_key,
         CASE WHEN t.same_file_target_count = 1 THEN r.file_path
              WHEN t.same_file_target_count = 0 AND c.scope_target_count = 1 THEN c.scope_target_file_path END AS target_file_path
  FROM raw_edges r
  JOIN source_matches s ON s.edge_key = r.edge_key
  JOIN same_file_targets t ON t.edge_key = r.edge_key
  JOIN scope_targets c ON c.edge_key = r.edge_key`;
  }

  static #quote(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
  }

  // SQL scope of a set of files inside one owner/cache partition: `predicate`
  // for a table alias (FileBlocks or node_rows), `rows`/`params` for DELETE.
  static #fileScope({ owner, cacheKey, files }) {
    return {
      predicate: (alias) => {
        const scope = files.map(({ rootId, filePath }) => (rootId === null
          ? `${alias}.file_path = ${GraphProjection.#quote(filePath)}`
          : `(${alias}.root_id = ${GraphProjection.#quote(rootId)} AND ${alias}.file_path = ${GraphProjection.#quote(filePath)})`)).join(' OR ');
        return `${alias}.owner = ${GraphProjection.#quote(owner)} AND ${alias}.cache_key = ${GraphProjection.#quote(cacheKey)} AND (${scope})`;
      },
      rows: files.map(({ rootId }) => (rootId === null
        ? '(root_id IS NOT NULL AND file_path = ?)'
        : '(root_id = ? AND file_path = ?)')).join(' OR '),
      params: files.flatMap(({ rootId, filePath }) => (rootId === null ? [filePath] : [rootId, filePath])),
    };
  }

  // Files outside `files` that import a module resolving to one of `files`.
  static #importersOf(db, { owner, cacheKey, files }) {
    const reaches = files.map(({ rootId, filePath }) => (rootId === null
      ? `candidate.value = ${GraphProjection.#quote(filePath)}`
      : `(m.root_id = ${GraphProjection.#quote(rootId)} AND candidate.value = ${GraphProjection.#quote(filePath)})`)).join(' OR ');
    const changed = new Set(files.map(({ rootId, filePath }) => `${rootId}\u0000${filePath}`));
    return db.prepare(`
      SELECT DISTINCT m.root_id AS rootId, m.file_path AS filePath
      FROM node_rows m
      CROSS JOIN json_each(ctx_module_candidates(m.file_path, substr(json_extract(m.structure, '$.displayName'), 8))) AS candidate
      WHERE m.owner = ? AND m.cache_key = ? AND m.node_kind = 'external_module'
        AND json_extract(m.structure, '$.displayName') LIKE 'module:%'
        AND (${reaches})
    `).all(owner, cacheKey)
      .filter(({ rootId, filePath }) => !changed.has(`${rootId}\u0000${filePath}`)
        && !changed.has(`null\u0000${filePath}`));
  }

  // Rebuild one owner/cache partition (or every partition when owner is null)
  // with the same SQL that refreshGraphProjection applies to changed files, so a
  // full rebuild is by construction the refresh of every file. The caller owns
  // the surrounding transaction when this is part of FileBlock publication.
  static #rebuildGraphProjection(db, { owner = null, cacheKey = null } = {}) {
    GraphProjection.#registerProjectionFunctions(db);
    const scoped = owner !== null;
    if (scoped) {
      db.prepare('DELETE FROM node_rows WHERE owner = ? AND cache_key = ?').run(owner, cacheKey);
      db.prepare('DELETE FROM edge_rows WHERE owner = ? AND cache_key = ?').run(owner, cacheKey);
    } else {
      db.exec('DELETE FROM node_rows; DELETE FROM edge_rows;');
    }
    const predicate = (alias) => (scoped ? `${alias}.owner = ${GraphProjection.#quote(owner)} AND ${alias}.cache_key = ${GraphProjection.#quote(cacheKey)}` : '1 = 1');
    db.prepare(GraphProjection.#graphNodeInsertSql({ predicate })).run();
    db.prepare(GraphProjection.#graphEdgeInsertSql({ predicate })).run();
  }

  // Refresh only the FileBlocks whose JSONB changed. Existing node_rows remain
  // the projection source for all untouched files; edge resolution is refreshed
  // from the materialized edge columns, so this path does not rescan unchanged
  // FileBlock JSONB.
  static #refreshGraphProjection(db, { owner, cacheKey, filePaths = [] } = {}) {
    if (owner === undefined || cacheKey === undefined) {
      throw new TypeError('refreshGraphProjection requires owner and cacheKey.');
    }
    GraphProjection.#registerProjectionFunctions(db);
    const files = [...new Map(filePaths.map((value) => {
      if (typeof value === 'string') return [`\u0000${value}`, { rootId: null, filePath: value }];
      return [`${value?.rootId}\u0000${value?.filePath}`, value];
    }))]
      .map(([, value]) => value)
      .filter((value) => value && typeof value.filePath === 'string' && value.filePath.length > 0
        && (value.rootId === null || typeof value.rootId === 'string'));
    if (files.length === 0) {
      GraphProjection.#refreshEdgeResolution(db, { owner, cacheKey });
      return;
    }
    const affectedScope = files.map(({ rootId, filePath }) => (rootId === null
      ? `(e.file_path = ${GraphProjection.#quote(filePath)} OR e.target_file_path = ${GraphProjection.#quote(filePath)})`
      : `(e.root_id = ${GraphProjection.#quote(rootId)} AND (e.file_path = ${GraphProjection.#quote(filePath)} OR e.target_file_path = ${GraphProjection.#quote(filePath)}))`)).join(' OR ');
    const rootScope = [...new Set(files.map(({ rootId }) => rootId).filter((value) => value !== null))]
      .map((rootId) => `e.root_id = ${GraphProjection.#quote(rootId)}`).join(' OR ');
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS ctx_affected_edge_keys (edge_key TEXT PRIMARY KEY);
      DELETE FROM ctx_affected_edge_keys;
      INSERT OR IGNORE INTO ctx_affected_edge_keys (edge_key)
      SELECT e.edge_key
      FROM edge_rows e
      WHERE e.owner = ${GraphProjection.#quote(owner)}
        AND e.cache_key = ${GraphProjection.#quote(cacheKey)}
        AND ((${affectedScope})${rootScope ? ` OR (e.resolution_status IN ('unresolved', 'ambiguous') AND (${rootScope}))` : ''});
    `);
    // An import edge's target is rewritten to the module's file when that file
    // exists, so adding or removing a file changes the edges of every file that
    // imports it. Those importers keep their nodes but must have their edges
    // derived again.
    const dependents = GraphProjection.#importersOf(db, { owner, cacheKey, files });
    const nodeScope = GraphProjection.#fileScope({ owner, cacheKey, files });
    const edgeScope = GraphProjection.#fileScope({ owner, cacheKey, files: [...files, ...dependents] });
    db.prepare(`DELETE FROM node_rows WHERE owner = ? AND cache_key = ? AND (${nodeScope.rows})`)
      .run(owner, cacheKey, ...nodeScope.params);
    db.prepare(`DELETE FROM edge_rows WHERE owner = ? AND cache_key = ? AND (${edgeScope.rows})`)
      .run(owner, cacheKey, ...edgeScope.params);
    db.prepare(GraphProjection.#graphNodeInsertSql({ predicate: nodeScope.predicate })).run();
    db.prepare(GraphProjection.#graphEdgeInsertSql({ predicate: edgeScope.predicate })).run();
    db.prepare(`
      INSERT OR IGNORE INTO ctx_affected_edge_keys (edge_key)
      SELECT edge_key FROM edge_rows
      WHERE owner = ? AND cache_key = ? AND (${edgeScope.rows})
    `).run(owner, cacheKey, ...edgeScope.params);
    GraphProjection.#refreshEdgeResolution(db, { owner, cacheKey, affectedEdgeTable: 'ctx_affected_edge_keys' });
    db.exec('DROP TABLE IF EXISTS temp.ctx_affected_edge_keys');
  }

  // Re-resolve materialized edges after a node partition changes. This keeps
  // cross-file targets correct without rebuilding raw edges from every JSONB
  // FileBlock.
  static #refreshEdgeResolution(db, { owner, cacheKey, affectedEdgeTable = null } = {}) {
    if (owner === undefined || cacheKey === undefined) {
      throw new TypeError('refreshEdgeResolution requires owner and cacheKey.');
    }
    const ownerValue = GraphProjection.#quote(owner);
    const cacheValue = GraphProjection.#quote(cacheKey);
    const edgeFilter = affectedEdgeTable
      ? ` AND EXISTS (SELECT 1 FROM ${affectedEdgeTable} affected WHERE affected.edge_key = e.edge_key)`
      : '';
    db.exec(`
      WITH source_matches AS MATERIALIZED (
        SELECT e.edge_key, COUNT(n.node_key) AS source_count, MAX(n.node_key) AS source_node_key
        FROM edge_rows e
        LEFT JOIN node_rows n
          ON n.owner = e.owner AND n.cache_key = e.cache_key AND n.root_id = e.root_id
         AND n.producer_generation = e.producer_generation AND n.file_path = e.file_path
         AND n.node_id = e.source_id
        WHERE e.owner = ${ownerValue} AND e.cache_key = ${cacheValue}${edgeFilter}
        GROUP BY e.edge_key
      ), same_file_targets AS MATERIALIZED (
        SELECT e.edge_key, COUNT(n.node_key) AS same_file_target_count, MAX(n.node_key) AS same_file_target_key
        FROM edge_rows e
        LEFT JOIN node_rows n
          ON n.owner = e.owner AND n.cache_key = e.cache_key AND n.root_id = e.root_id
         AND n.producer_generation = e.producer_generation AND n.file_path = e.file_path
         AND n.node_id = e.target_id
        WHERE e.owner = ${ownerValue} AND e.cache_key = ${cacheValue}${edgeFilter}
        GROUP BY e.edge_key
      ), scope_targets AS MATERIALIZED (
        SELECT e.edge_key, COUNT(n.node_key) AS scope_target_count,
               MAX(n.node_key) AS scope_target_key, MAX(n.file_path) AS scope_target_file_path
        FROM edge_rows e
        LEFT JOIN node_rows n
          ON n.owner = e.owner AND n.cache_key = e.cache_key AND n.root_id = e.root_id
         AND n.producer_generation = e.producer_generation AND n.node_id = e.target_id
        WHERE e.owner = ${ownerValue} AND e.cache_key = ${cacheValue}${edgeFilter}
        GROUP BY e.edge_key
      ), resolved AS MATERIALIZED (
        SELECT e.edge_key,
          CASE WHEN s.source_count = 1 THEN s.source_node_key END AS source_node_key,
          CASE WHEN s.source_count = 0 THEN 'unresolved'
               WHEN s.source_count > 1 THEN 'ambiguous'
               WHEN t.same_file_target_count = 1 OR (t.same_file_target_count = 0 AND c.scope_target_count = 1) THEN 'resolved'
               WHEN t.same_file_target_count > 1 OR c.scope_target_count > 1 THEN 'ambiguous'
               ELSE 'unresolved' END AS resolution_status,
          CASE WHEN s.source_count = 0 THEN 'source_not_found'
               WHEN s.source_count > 1 THEN 'source_ambiguous'
               WHEN t.same_file_target_count > 1 THEN 'target_ambiguous_in_source_file'
               WHEN t.same_file_target_count = 0 AND c.scope_target_count > 1 THEN 'target_ambiguous_in_scope'
               WHEN t.same_file_target_count = 0 AND c.scope_target_count = 0 THEN 'target_not_found' END AS resolution_reason,
          CASE WHEN t.same_file_target_count = 1 THEN t.same_file_target_key
               WHEN t.same_file_target_count = 0 AND c.scope_target_count = 1 THEN c.scope_target_key END AS target_node_key,
          CASE WHEN t.same_file_target_count = 1 THEN e.file_path
               WHEN t.same_file_target_count = 0 AND c.scope_target_count = 1 THEN c.scope_target_file_path END AS target_file_path
        FROM edge_rows e
        JOIN source_matches s ON s.edge_key = e.edge_key
        JOIN same_file_targets t ON t.edge_key = e.edge_key
        JOIN scope_targets c ON c.edge_key = e.edge_key
        WHERE e.owner = ${ownerValue} AND e.cache_key = ${cacheValue}${edgeFilter}
      )
      UPDATE edge_rows AS e
      SET source_node_key = (SELECT source_node_key FROM resolved r WHERE r.edge_key = e.edge_key),
          resolution_status = (SELECT resolution_status FROM resolved r WHERE r.edge_key = e.edge_key),
          resolution_reason = (SELECT resolution_reason FROM resolved r WHERE r.edge_key = e.edge_key),
          target_node_key = (SELECT target_node_key FROM resolved r WHERE r.edge_key = e.edge_key),
          target_file_path = (SELECT target_file_path FROM resolved r WHERE r.edge_key = e.edge_key)
      WHERE e.owner = ${ownerValue} AND e.cache_key = ${cacheValue}${edgeFilter};
    `);
  }

  static #graphProjectionViews(nodeTable = 'node_rows', edgeTable = 'edge_rows') {
    return [
      `CREATE VIEW nodes AS
         SELECT DISTINCT name, structure, behavior FROM ${nodeTable}`,
      `CREATE VIEW edges AS
         SELECT source_path AS frompath, target_path AS topath, edge_kind AS kind FROM ${edgeTable}`,
      `CREATE VIEW graph_nodes AS
         SELECT owner, cache_key, root_id, producer_generation, file_path,
                node_id, raw_node_id, node_kind, json_path, node_key
         FROM ${nodeTable}`,
      `CREATE VIEW graph_edges AS
         SELECT edge_ordinal, owner, cache_key, root_id, producer_generation, file_path,
                source_id, target_id, source_path, target_path, edge_kind, json_path,
                source_node_key, resolution_status, resolution_reason, target_node_key, target_file_path
         FROM ${edgeTable}`,
    ];
  }

  static #partitionErrors({ owner, cacheKey }) {
    return [
      ...(isText(owner) ? [] : ['owner: must be a non-empty string']),
      ...(isText(cacheKey) ? [] : ['cacheKey: must be a non-empty string']),
    ];
  }

  // Always one owner/cache partition: an unscoped rebuild is reserved for the
  // schema migration, which calls rebuildGraphProjection directly.
  rebuild({ owner, cacheKey } = {}) {
    assertPayload({ target: 'GraphProjection', method: 'rebuild', errors: GraphProjection.#partitionErrors({ owner, cacheKey }) });
    GraphProjection.#rebuildGraphProjection(this.#db, { owner, cacheKey });
  }

  refresh({ owner, cacheKey, filePaths = [] } = {}) {
    assertPayload({
      target: 'GraphProjection',
      method: 'refresh',
      errors: [
        ...GraphProjection.#partitionErrors({ owner, cacheKey }),
        ...(Array.isArray(filePaths) ? [] : ['filePaths: must be an array']),
      ],
    });
    GraphProjection.#refreshGraphProjection(this.#db, { owner, cacheKey, filePaths });
  }

  drop({ owner, cacheKey = null }) {
    const { where, params } = ownerScope({ owner, cacheKey });
    this.#db.prepare(`DELETE FROM node_rows WHERE ${where}`).run(...params);
    this.#db.prepare(`DELETE FROM edge_rows WHERE ${where}`).run(...params);
  }
}
