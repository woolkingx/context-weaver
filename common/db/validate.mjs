// Draft-07 FileBlock validation shared by Tools API and cache boundaries.
import { createRequire } from 'node:module';
import { loadFileBlockSchema } from './ddl.mjs';
import { Loader, validate } from '../schema2object.mjs';

const schema = loadFileBlockSchema();
const require = createRequire(import.meta.url);
const OWNER_SCHEMAS = Object.fromEntries(['rule', 'skill', 'handbook', 'codebase'].map((owner) => [
  owner,
  // eslint-disable-next-line import-x/no-dynamic-require -- owner schemas are selected by the validated owner name.
  require(`../owners/${owner}.schema.json`),
]));
const SCHEMAS_BY_NAME = new Map(Object.values(OWNER_SCHEMAS).map((ownerSchema) => [
  new URL(ownerSchema.$id).pathname.split('/').at(-1),
  ownerSchema,
]));
const OWNER_SCHEMA_BY_ID = Object.freeze({
  rules: 'rule', skills: 'skill', handbook: 'handbook', codebase: 'codebase',
});

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value === 'number' ? 'number' : typeof value;
}

function validateValue(def, value, label) {
  const errors = [];
  const allowed = Array.isArray(def.type) ? def.type : [def.type];
  if (def.type && !allowed.includes(typeOf(value)) && !(typeOf(value) === 'integer' && allowed.includes('number'))) {
    errors.push(`${label}: type ${typeOf(value)} not in ${JSON.stringify(def.type)}`);
    return errors;
  }
  if (typeof value === 'string' && def.minLength !== undefined && value.length < def.minLength) errors.push(`${label}: shorter than ${def.minLength}`);
  if (typeof value === 'number' && def.minimum !== undefined && value < def.minimum) errors.push(`${label}: below minimum ${def.minimum}`);
  if (def.type === 'object' && value && !Array.isArray(value)) errors.push(...validateObject(def, value, label));
  return errors;
}

function validateObject(def, value, label) {
  const errors = [];
  // Draft-07 `required` means the property must exist. A nullable property
  // remains valid when its value is null; validateValue below enforces the
  // declared type union.
  for (const key of def.required ?? []) if (value[key] === undefined) errors.push(`${label}: missing required '${key}'`);
  for (const [key, item] of Object.entries(value)) {
    const property = def.properties?.[key];
    if (!property) {
      if (def.additionalProperties === false) errors.push(`${label}: unknown property '${key}'`);
      continue;
    }
    errors.push(...validateValue(property, item, `${label}.${key}`));
  }
  return errors;
}

export function validateFileBlock(block, label = 'FileBlock') {
  const errors = validateObject(schema.definitions.StorageFileBlock, block, label);
  if (!isRelativePath(block.file_path)) errors.push(`${label}.file_path: must be a non-empty relative path without traversal`);
  if (typeof block.root_id !== 'string' || block.root_id.length === 0) errors.push(`${label}.root_id: must be a non-empty source root identity`);
  const ownerSchema = OWNER_SCHEMAS[OWNER_SCHEMA_BY_ID[block.owner]];
  if (ownerSchema && !validateOwnerValue(block.owner, block.value)) errors.push(`${label}.value: invalid ${block.owner} owner value`);
  return errors;
}

function isRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.split('/').some((segment) => segment === '.' || segment === '..');
}

// The manifest fields the cache stores as NOT NULL columns. The wider OwnerInput
// schema is deliberately not enforced here: producers may emit null file hashes.
export function validateCacheManifest(manifest, label = 'CacheManifest') {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return [`${label}: must be an object`];
  const errors = [];
  const isDigest = (value) => typeof value === 'string' && /^[A-Fa-f0-9]{64}$/.test(value);
  if (!isDigest(manifest.fingerprint)) errors.push(`${label}.fingerprint: must be a 64-character hex digest`);
  if (!isDigest(manifest.policyFingerprint)) errors.push(`${label}.policyFingerprint: must be a 64-character hex digest`);
  if (typeof manifest.producerGeneration !== 'string' || manifest.producerGeneration.length === 0) errors.push(`${label}.producerGeneration: must be a non-empty string`);
  if (!Number.isInteger(manifest.admittedFileCount) || manifest.admittedFileCount < 0) errors.push(`${label}.admittedFileCount: must be a non-negative integer`);
  if (manifest.files !== undefined && !Array.isArray(manifest.files)) errors.push(`${label}.files: must be an array`);
  return errors;
}

export function validateOwnerValue(owner, value) {
  const schemaName = OWNER_SCHEMA_BY_ID[owner];
  const ownerSchema = OWNER_SCHEMAS[schemaName];
  if (!ownerSchema) return true;
  const loader = new Loader(ownerSchema, (uri) => SCHEMAS_BY_NAME.get(new URL(uri).pathname.split('/').at(-1)), ownerSchema.$id);
  return validate(value, ownerSchema, loader).valid;
}

export function validateTokenWeight(row, label = 'token_weight') {
  const errors = [];
  for (const key of ['token_a', 'token_b', 'score']) if (row[key] === undefined || row[key] === null) errors.push(`${label}: missing required '${key}'`);
  if (typeof row.score !== 'number') errors.push(`${label}: score must be a number`);
  return errors;
}

export function assertValid(rows, validate, kind) {
  for (const row of rows) {
    const errors = validate(row, kind);
    if (errors.length) throw new Error(`Invalid ${kind} row: ${errors.join('; ')}`);
  }
  return rows;
}
