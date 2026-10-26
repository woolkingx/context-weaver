/**
 * ConfigOwner - Shared Configuration Management (Class-based)
 *
 * Mature, class-based implementation following mjs class principles:
 * - Encapsulates configuration state and behavior
 * - Clear boundary: resolves one effective invocation context
 * - Source precedence: schema defaults > user > project > environment > CLI
 * - Validation, provenance tracking, path resolution
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_PATH = path.join(__here, 'config.schema.json');

export class ConfigOwner {
  constructor({ schemaPath = DEFAULT_SCHEMA_PATH } = {}) {
    this.schemaPath = schemaPath;
    this.schema = null;
    this.resolved = null;
    this.resolvedRoot = null;
  }

  resolve({
    root = process.cwd(), cliValues = {}, env = process.env, home = os.homedir(),
  } = {}) {
    const normalizedRoot = path.resolve(root);
    this.schema = this._loadSchema();
    this.resolvedRoot = normalizedRoot;
    this.home = home;
    this.resolved = this._resolve({
      normalizedRoot, cliValues, env, home,
    });
    return this.resolved;
  }

  _loadSchema() {
    if (this.schema) return this.schema;
    try {
      const schemaText = readFileSync(this.schemaPath, 'utf8');
      return JSON.parse(schemaText);
    } catch (error) {
      throw new Error(`config.schema.read: Failed to read schema from ${this.schemaPath}: ${error.message}`);
    }
  }

  _resolve({
    normalizedRoot, cliValues, env, home,
  }) {
    const sources = this._loadSources({ normalizedRoot, cliValues, env });
    const merged = this._mergeSources(sources);
    const paths = this._resolvePaths({
      merged, normalizedRoot, env, home,
    });
    const provenance = this._buildProvenance(sources, merged);
    return {
      object: 'ConfigResolution',
      root: normalizedRoot,
      values: merged,
      paths,
      provenance,
      sources: sources.map((s) => ({
        name: s.name, scope: s.scope, path: s.path, present: s.present,
      })),
      diagnostics: [],
      fingerprint: ConfigOwner._fingerprint(merged),
      timestamp: new Date().toISOString(),
    };
  }

  _loadSources({ normalizedRoot, cliValues, env }) {
    const sources = [
      {
        name: 'schema', scope: 'builtin', path: this.schemaPath, present: true, value: defaultsFromSchema(this.schema),
      },
      this._loadUserConfig(env),
      this._loadProjectConfig(normalizedRoot),
      this._loadEnvironmentConfig(env),
    ];
    if (cliValues && Object.keys(cliValues).length > 0) {
      sources.push(this._sourceWithValidation({
        name: 'cli', scope: 'invocation', path: null, present: true, value: cliValues,
      }));
    }
    return sources;
  }

  _loadUserConfig(env = process.env) {
    const configHome = env.XDG_CONFIG_HOME || path.join(this.home ?? os.homedir(), '.config');
    const userConfigPath = path.join(configHome, 'context-weaver', 'config.json');
    if (!existsSync(userConfigPath)) {
      return {
        name: 'user', scope: 'user', path: userConfigPath, present: false, value: {},
      };
    }
    let value;
    try {
      value = JSON.parse(readFileSync(userConfigPath, 'utf8'));
    } catch (error) {
      throw configSourceError('config.source.json', 'user', userConfigPath, error.message);
    }
    return this._sourceWithValidation({
      name: 'user', scope: 'user', path: userConfigPath, present: true, value,
    });
  }

  _loadProjectConfig(root) {
    const projectConfigPath = path.join(root, 'context-weaver.config.json');
    if (!existsSync(projectConfigPath)) {
      return {
        name: 'project', scope: 'project', path: projectConfigPath, present: false, value: {},
      };
    }
    let value;
    try {
      value = JSON.parse(readFileSync(projectConfigPath, 'utf8'));
    } catch (error) {
      throw configSourceError('config.source.json', 'project', projectConfigPath, error.message);
    }
    return this._sourceWithValidation({
      name: 'project', scope: 'project', path: projectConfigPath, present: true, value,
    });
  }

  _loadEnvironmentConfig(env) {
    const entries = this._extractSchemaLeaves(this.schema.properties || {}, []);
    const environmentConfig = {};
    for (const entry of entries) {
      const envKey = ConfigOwner._envNameForPath(entry.path);
      if (Object.hasOwn(env, envKey)) {
        assignPath(environmentConfig, entry.path, ConfigOwner._parseEnvValue(env[envKey], entry.schema, envKey));
      }
    }
    if (Object.keys(environmentConfig).length === 0) {
      return {
        name: 'environment', scope: 'process', path: null, present: false, value: {},
      };
    }
    return this._sourceWithValidation({
      name: 'environment', scope: 'process', path: null, present: true, value: environmentConfig,
    });
  }

  _extractSchemaLeaves(properties, prefix) {
    const leaves = [];
    for (const [key, schema] of Object.entries(properties)) {
      if (key === '$schema') continue;
      const pathValue = [...prefix, key];
      if (schema?.type === 'object' && schema.properties) {
        leaves.push(...this._extractSchemaLeaves(schema.properties, pathValue));
      } else {
        leaves.push({ path: pathValue, schema });
      }
    }
    return leaves;
  }

  static _envNameForPath(pathParts) {
    return `CTX_${pathParts.map((part) => part.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()).join('_')}`;
  }

  static _parseEnvValue(raw, schema, key) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.includes('object') || types.includes('array') || raw === 'null') {
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw configSourceError('config.environment.value', 'environment', null, `${key}: ${error.message}`);
      }
    }
    if (types.includes('integer')) {
      const num = Number(raw);
      if (!Number.isInteger(num)) throw configSourceError('config.environment.value', 'environment', null, `${key}: expected integer`);
      return num;
    }
    if (types.includes('boolean')) {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw configSourceError('config.environment.value', 'environment', null, `${key}: expected true or false`);
    }
    return raw;
  }

  _sourceWithValidation(source) {
    if (!source.present) return source;
    const errors = validateValue(source.value, this.schema, '');
    if (errors.length > 0) throw configSourceError('config.source.validation', source.name, source.path, errors);
    return source;
  }

  _mergeSources(sources) {
    let merged = {};
    for (const source of sources) {
      if (!source.present) continue;
      merged = this._deepMerge(merged, source.value);
    }
    delete merged.$schema;
    return merged;
  }

  _deepMerge(base, override) {
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
      return override === undefined ? base : structuredClone(override);
    }
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this._deepMerge(result[key] || {}, value);
      } else {
        result[key] = structuredClone(value);
      }
    }
    return result;
  }

  _resolvePaths({
    merged, normalizedRoot, env, home = this.home ?? os.homedir(),
  }) {
    const stateHome = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
    const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
    const override = merged.paths || {};
    return {
      configHome: path.join(configHome, 'context-weaver'),
      userConfigFile: path.join(configHome, 'context-weaver', 'config.json'),
      projectConfigFile: path.join(normalizedRoot, 'context-weaver.config.json'),
      stateDir: ConfigOwner._absoluteOr(override.stateDir, path.join(stateHome, 'context-weaver')),
      auditDir: path.join(ConfigOwner._absoluteOr(override.stateDir, path.join(stateHome, 'context-weaver')), 'logs'),
      legacyAuditDir: path.join(home, '.ctx', 'logs'),
      cacheDir: ConfigOwner._absoluteOr(override.cacheDir, path.join(home, '.ctx', 'cache')),
      dataDir: ConfigOwner._absoluteOr(override.dataDir, path.join(dataHome, 'context-weaver')),
      tokenMatrixFile: path.join(ConfigOwner._absoluteOr(override.dataDir, path.join(dataHome, 'context-weaver')), 'token-matrix.json'),
      legacyTokenMatrixFile: path.join(home, '.ctx', 'token-matrix.json'),
    };
  }

  static _absoluteOr(value, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new Error(`config.path.absolute: Path must be absolute, got ${value}`);
    }
    return path.normalize(value);
  }

  _buildProvenance(sources, _merged) {
    const provenance = {};
    for (const source of sources) {
      if (!source.present) continue;
      this._recordProvenance(provenance, source.value, source);
    }
    return provenance;
  }

  _recordProvenance(provenance, value, source, prefix = '') {
    for (const [key, val] of Object.entries(value || {})) {
      const pathKey = prefix ? `${prefix}.${key}` : key;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        this._recordProvenance(provenance, val, source, pathKey);
      } else {
        provenance[pathKey] = {
          source: source.name,
          scope: source.scope,
          location: source.path,
          sensitive: ConfigOwner._isSensitivePath(pathKey),
        };
      }
    }
  }

  static _isSensitivePath(pathKey) {
    return ['password', 'secret', 'token', 'key', 'credential'].some((p) => pathKey.toLowerCase().includes(p));
  }

  static _fingerprint(config) {
    const str = JSON.stringify(config);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = Math.imul(hash, 31) + str.charCodeAt(i);
      hash %= 2 ** 32;
      if (hash >= 2 ** 31) hash -= 2 ** 32;
    }
    return Math.abs(hash).toString(16);
  }
}

export default ConfigOwner;

function defaultsFromSchema(schema) {
  if (Object.hasOwn(schema ?? {}, 'default')) return structuredClone(schema.default);
  if (schema?.type === 'object' || schema?.properties) {
    const value = {};
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key === '$schema') continue;
      const resolved = defaultsFromSchema(child);
      if (resolved !== undefined) value[key] = resolved;
    }
    return value;
  }
  return undefined;
}

function assignPath(target, parts, value) {
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part]) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function configSourceError(code, source, filePath, errors) {
  const list = Array.isArray(errors) ? errors : [String(errors)];
  const error = new Error(`${code}: ${list.join('; ')}`);
  error.code = code;
  error.source = source;
  error.path = filePath;
  error.errors = list;
  return error;
}

function validateValue(value, schema, pathKey) {
  if (!schema) return [];
  const errors = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (value === null) {
    if (!types.includes('null')) errors.push(`${pathKey || 'config'}: expected ${types.join(' or ')}`);
    return errors;
  }
  if (types.includes('object') && (typeof value !== 'object' || Array.isArray(value))) {
    errors.push(`${pathKey || 'config'}: expected object`);
    return errors;
  }
  if (types.includes('array') && !Array.isArray(value)) {
    errors.push(`${pathKey || 'config'}: expected array`);
    return errors;
  }
  if (types.includes('integer') && (!Number.isInteger(value) || (schema.minimum !== undefined && value < schema.minimum))) {
    errors.push(`${pathKey || 'config'}: expected integer >= ${schema.minimum ?? '-Infinity'}`);
    return errors;
  }
  if (types.includes('string') && typeof value !== 'string') {
    errors.push(`${pathKey || 'config'}: expected string`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${pathKey || 'config'}: expected one of ${schema.enum.join(', ')}`);
  if (schema.pattern && typeof value === 'string' && !(new RegExp(schema.pattern).test(value))) errors.push(`${pathKey || 'config'}: does not match ${schema.pattern}`);
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateValue(item, schema.items, `${pathKey}[${index}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) errors.push(`${pathKey || 'config'}.${key}: unknown property`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) errors.push(...validateValue(value[key], child, pathKey ? `${pathKey}.${key}` : key));
    }
  }
  return errors;
}
