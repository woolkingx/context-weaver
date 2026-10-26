import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = fileURLToPath(new URL('./file-block.schema.json', import.meta.url));
const JSON_TO_SQL = {
  string: 'TEXT', integer: 'INTEGER', number: 'REAL', boolean: 'INTEGER', object: 'TEXT', array: 'TEXT',
};
export const FILE_BLOCK_SCHEMA_VERSION = '1';
export const DERIVED_PROJECTION_SCHEMA_VERSION = 5;

export function loadFileBlockSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}

function tableFromDef(tableName, def, { ifNotExists = false } = {}) {
  const required = new Set(def.required ?? []);
  const columns = Object.entries(def.properties).map(([name, property]) => {
    const types = Array.isArray(property.type) ? property.type : [property.type];
    const baseType = types.find((type) => type && type !== 'null') ?? 'string';
    const sqlType = ['value', 'file_revision_set', 'snapshot'].includes(name) ? 'BLOB' : JSON_TO_SQL[baseType] ?? 'TEXT';
    const nullable = types.includes('null');
    let sql = `${name} ${sqlType}`;
    if (['owner', 'cache_key', 'root_id', 'file_path'].includes(name)) sql += ' NOT NULL';
    if (required.has(name) && !nullable) sql += ' NOT NULL';
    return sql;
  });
  const exists = ifNotExists ? 'IF NOT EXISTS ' : '';
  return `CREATE TABLE ${exists}${tableName} (\n${columns.map((column) => `  ${column}`).join(',\n')},\n  PRIMARY KEY (owner, cache_key, root_id, file_path)\n);`;
}

const CACHE_MANIFEST_DDL = `CREATE TABLE IF NOT EXISTS cache_manifests (
  owner TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  producer_generation TEXT NOT NULL,
  admitted_file_count INTEGER NOT NULL,
  policy_fingerprint TEXT NOT NULL,
  file_revision_set BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner, cache_key)
);`;

const CACHE_RELEASE_DDL = `CREATE TABLE IF NOT EXISTS cache_releases (
  owner TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  release_id TEXT NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  file_revision_set BLOB NOT NULL,
  PRIMARY KEY (owner, cache_key, release_id)
);`;

const FILES_DDL = `CREATE TABLE IF NOT EXISTS files (
  owner TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  root_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  fingerprint TEXT,
  mtime_ms REAL,
  size INTEGER,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  projection_generation TEXT,
  node_status TEXT,
  edge_status TEXT,
  incompatible INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  error_context BLOB,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner, cache_key, root_id, file_path)
);`;

const NODE_ROWS_DDL = `CREATE TABLE %IF_NOT_EXISTS%node_rows (
  owner TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  root_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  producer_generation TEXT NOT NULL,
  node_id TEXT NOT NULL,
  raw_node_id TEXT,
  node_kind TEXT NOT NULL,
  json_path TEXT NOT NULL,
  node_key TEXT NOT NULL,
  name TEXT,
  structure TEXT,
  behavior TEXT,
  PRIMARY KEY (owner, cache_key, root_id, file_path, json_path, node_id, node_kind)
);`;

const EDGE_ROWS_DDL = `CREATE TABLE %IF_NOT_EXISTS%edge_rows (
  edge_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  root_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  producer_generation TEXT NOT NULL,
  edge_ordinal INTEGER NOT NULL,
  source_id TEXT,
  target_id TEXT,
  source_path TEXT,
  target_path TEXT,
  edge_kind TEXT,
  json_path TEXT NOT NULL,
  source_node_key TEXT,
  resolution_status TEXT NOT NULL,
  resolution_reason TEXT,
  target_node_key TEXT,
  target_file_path TEXT
);`;

const DERIVED_PROJECTION_DDL = [
  NODE_ROWS_DDL,
  EDGE_ROWS_DDL,
  'CREATE INDEX %IF_NOT_EXISTS%node_rows_file_node ON node_rows(owner, cache_key, root_id, producer_generation, file_path, node_id);',
  'CREATE INDEX %IF_NOT_EXISTS%node_rows_scope_node ON node_rows(owner, cache_key, root_id, producer_generation, node_id);',
  'CREATE INDEX %IF_NOT_EXISTS%node_rows_node_key ON node_rows(node_key);',
  'CREATE INDEX %IF_NOT_EXISTS%edge_rows_source ON edge_rows(owner, cache_key, root_id, producer_generation, source_node_key);',
  'CREATE INDEX %IF_NOT_EXISTS%edge_rows_target ON edge_rows(owner, cache_key, root_id, producer_generation, target_node_key);',
  'CREATE INDEX %IF_NOT_EXISTS%edge_rows_file ON edge_rows(owner, cache_key, root_id, file_path);',
].join('\n\n');

export const RUNTIME_INDEXES = Object.freeze([
  'CREATE INDEX IF NOT EXISTS files_owner_status ON files(owner, cache_key, status, incompatible);',
  'CREATE INDEX IF NOT EXISTS files_root_path ON files(root_id, file_path);',
  'CREATE INDEX IF NOT EXISTS file_blocks_owner ON file_blocks(owner);',
  'CREATE INDEX IF NOT EXISTS file_blocks_root_path ON file_blocks(root_id, file_path);',
  'CREATE INDEX IF NOT EXISTS file_blocks_path ON file_blocks(file_path);',
  'CREATE INDEX IF NOT EXISTS file_blocks_fingerprint ON file_blocks(fingerprint);',
  'CREATE INDEX IF NOT EXISTS token_weight_token_pair ON token_weight(token_a, token_b);',
]);

export function buildDdl(schema = loadFileBlockSchema()) {
  const fileBlock = schema.definitions?.StorageFileBlock;
  if (!fileBlock) throw new Error('FileBlock schema definition is missing');
  return [
    tableFromDef('file_blocks', fileBlock),
    FILES_DDL,
    DERIVED_PROJECTION_DDL.replaceAll('%IF_NOT_EXISTS%', ''),
    'CREATE TABLE token_weight (\n  token_a TEXT NOT NULL,\n  token_b TEXT NOT NULL,\n  score REAL NOT NULL,\n  PRIMARY KEY (token_a, token_b)\n);',
    ...RUNTIME_INDEXES,
  ].join('\n\n');
}

export function buildPersistentDdl(schema = loadFileBlockSchema()) {
  const fileBlock = schema.definitions?.StorageFileBlock;
  if (!fileBlock) throw new Error('FileBlock schema definition is missing');
  return [
    tableFromDef('file_blocks', fileBlock, { ifNotExists: true }),
    DERIVED_PROJECTION_DDL.replaceAll('%IF_NOT_EXISTS%', 'IF NOT EXISTS '),
    'CREATE TABLE IF NOT EXISTS token_weight (\n  token_a TEXT NOT NULL,\n  token_b TEXT NOT NULL,\n  score REAL NOT NULL,\n  PRIMARY KEY (token_a, token_b)\n);',
    CACHE_MANIFEST_DDL,
    CACHE_RELEASE_DDL,
    FILES_DDL,
    ...RUNTIME_INDEXES,
    'CREATE UNIQUE INDEX IF NOT EXISTS cache_manifests_owner_key ON cache_manifests(owner, cache_key);',
    'CREATE INDEX IF NOT EXISTS cache_releases_owner_key_created ON cache_releases(owner, cache_key, created_at);',
  ].join('\n\n');
}

export const DEF_TO_TABLE = Object.freeze({ FileBlock: 'file_blocks' });
export const PERSISTENT_DEF_TO_TABLE = Object.freeze({ FileBlock: 'file_blocks', CacheManifest: 'cache_manifests', CacheRelease: 'cache_releases' });
