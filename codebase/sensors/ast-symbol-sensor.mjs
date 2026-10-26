import path from 'node:path';

import { normalizeRoot } from '../../common/lib/normalize-root.mjs';
import { createSensorResult } from '../schema/context.mjs';
import { DEFAULT_IGNORE_NAMES } from '../../common/lib/file-scan.mjs';
import { FileOwner } from '../../common/owners/files-owner.mjs';
import { loadCachedOwnerBlocks } from '../owners/cached-owner-blocks.mjs';
import { cacheKeyFor } from '../db/cache-key.mjs';
import { LanguageParser } from '../../common/parsers/language-parser.mjs';

const symbolCache = new Map();

const AST_STOP_TOKENS = new Set([
  'custom',
  'event',
  'hook',
  'object',
  'output',
  'projection',
  'rule',
  'schema',
  'status',
  'tools',
  'topology',
  'tree',
]);

export class AstSymbolSensor {
  constructor({ ignoreNames = DEFAULT_IGNORE_NAMES } = {}) {
    this.ignoreNames = ignoreNames;
  }

  static symbolNameTokens(value) {
    return symbolNameTokens(value);
  }

  static async harvest({
    query, ruleRefs = [], fileBlockStore = null, cacheSession = null,
  } = {}) {
    if (fileBlockStore || cacheSession) {
      return AstSymbolSensor.#cachedSearch(query, {
        ruleRefs, fileBlockStore, cacheSession, harvest: true,
      });
    }
    const files = await AstSymbolSensor.#sourceFiles(query.root, Infinity);
    const hits = [];

    for (const file of files) {
      const content = await file.readText();
      if (content == null) continue;
      const symbols = await extractSymbolsCached(content, file.extension, file.absolutePath);
      for (const symbol of symbols) {
        hits.push(resultForSymbol({
          file,
          symbol,
          score: astRoleWeight(symbol.kind),
          ruleRefs,
          reason: 'repo-wide official AST harvest materializes every source symbol',
        }));
      }
    }

    return hits.sort(compareHits);
  }

  static async search({
    query, ruleRefs = [], fileBlockStore = null, cacheSession = null,
  } = {}) {
    if (fileBlockStore || cacheSession) return AstSymbolSensor.#cachedSearch(query, { ruleRefs, fileBlockStore, cacheSession });
    const tokens = symbolQueryTokens(query.query);
    if (tokens.length === 0) return [];

    const files = await AstSymbolSensor.#sourceFiles(query.root, query.budget.maxHits * 40);
    const hits = [];

    for (const file of files) {
      if (hits.length >= query.budget.maxHits) break;
      const content = await file.readText();
      if (content == null) continue;
      const symbols = await extractSymbolsCached(content, file.extension, file.absolutePath);
      for (const symbol of symbols) {
        const score = scoreSymbol(symbol, tokens);
        if (score <= 0) continue;
        hits.push(resultForSymbol({
          file, symbol, score, ruleRefs,
        }));
        if (hits.length >= query.budget.maxHits) break;
      }
    }

    return hits.sort((a, b) => b.score - a.score || compareHits(a, b));
  }

  static async #cachedSearch(query, {
    ruleRefs, fileBlockStore, cacheSession, harvest = false,
  }) {
    const cached = await loadCachedOwnerBlocks('codebase', normalizeRoot(query.root), fileBlockStore, cacheSession);
    const tokens = symbolQueryTokens(query.query);
    const hits = [];
    const store = cacheSession?.store ?? fileBlockStore;
    if (store && (cached?.blocks?.length ?? 0) === 0) {
      return searchCachedNodesSql(store, query, tokens, ruleRefs, harvest);
    }
    for (const block of cached?.blocks ?? []) {
      const ast = block.value?.ast;
      const sourceLines = String(ast?.source_text ?? '').split(/\r?\n/);
      const file = {
        path: block.file_path,
        name: path.basename(block.file_path),
        extension: path.extname(block.file_path).slice(1).toLowerCase(),
        size: block.size ?? null,
      };
      for (const node of ast?.nodes ?? []) {
        const structure = node.structure ?? {};
        const kind = cachedSymbolKind(structure.kind);
        const name = structure.displayName;
        if (!kind || !name) continue;
        const symbol = {
          kind,
          name,
          lineNumber: Number(structure.line) || 1,
          line: sourceLines[(Number(structure.line) || 1) - 1] ?? name,
        };
        const score = harvest ? astRoleWeight(kind) : scoreSymbol(symbol, tokens);
        if (score <= 0) continue;
        hits.push(resultForSymbol({
          file, symbol, score, ruleRefs, reason: 'cached FileBlock AST value',
        }));
      }
    }
    return hits.sort((a, b) => b.score - a.score || compareHits(a, b)).slice(0, harvest ? undefined : query.budget.maxHits);
  }

  static async #sourceFiles(root, maxFiles) {
    const fileSet = await (await FileOwner.forRoot(normalizeRoot(root))).listAdmittedFiles({
      maxFiles,
      acceptExtension: (ext) => LanguageParser.handlesExtension(ext),
      withSize: true,
    });
    return fileSet.files;
  }
}

function searchCachedNodesSql(store, query, tokens, ruleRefs, harvest) {
  const rows = store.query({
    sql: `
    SELECT file_path, node_kind, name,
           json_extract(structure, '$.displayName') AS display_name,
           json_extract(structure, '$.line') AS line,
           json_extract(structure, '$.excerpt') AS excerpt
    FROM node_rows
    WHERE owner = ? AND cache_key = ?
      AND node_kind IN ('class', 'enum', 'struct', 'trait', 'union', 'function', 'method', 'const', 'let', 'var')
    ORDER BY file_path, json_path
  `,
    params: ['codebase', cacheKeyFor('codebase', normalizeRoot(query.root))],
  });
  const hits = [];
  for (const row of rows) {
    const kind = cachedSymbolKind(row.node_kind);
    const name = row.display_name;
    if (!kind || !name) continue;
    const symbol = {
      kind,
      name,
      lineNumber: Number(row.line) || 1,
      line: row.excerpt ?? name,
    };
    const score = harvest ? astRoleWeight(kind) : scoreSymbol(symbol, tokens);
    if (score <= 0) continue;
    hits.push(resultForSymbol({
      file: {
        path: row.file_path,
        name: path.basename(row.file_path),
        extension: path.extname(row.file_path).slice(1).toLowerCase(),
        size: null,
      },
      symbol,
      score,
      ruleRefs,
      reason: 'indexed node_rows projection',
    }));
  }
  return hits.sort((a, b) => b.score - a.score || compareHits(a, b)).slice(0, harvest ? undefined : query.budget.maxHits);
}

function extractSymbols(content, extension, absolutePath = '') {
  return LanguageParser.extractSymbols({ content, extension, absolutePath });
}

function extractSymbolsCached(content, extension, absolutePath = '') {
  const key = `${absolutePath || '<memory>'}:${extension}`;
  if (!symbolCache.has(key)) {
    symbolCache.set(key, extractSymbols(content, extension, absolutePath));
  }
  return symbolCache.get(key);
}

function cachedSymbolKind(kind) {
  if (['class', 'enum', 'struct', 'trait', 'union'].includes(kind)) return 'class';
  if (['function', 'method', 'const', 'let', 'var'].includes(kind)) return kind;
  return null;
}

function resultForSymbol({
  file, symbol, score, ruleRefs, reason = 'query token matches a source symbol',
}) {
  const who = ruleRefs.length > 0
    ? `code official AST lane governed by ${ruleRefs.join(', ')}`
    : 'code official AST lane with no active rule file found';
  const tool = producerToolForExtension(file.extension);

  return createSensorResult({
    route: 'ast',
    lane: 'code',
    tool,
    command: 'internal:official-ast-symbols',
    path: file.path,
    startLine: symbol.lineNumber,
    endLine: symbol.lineNumber,
    excerpt: `${symbol.lineNumber}: ${symbol.line}`,
    score,
    metadata: {
      kind: 'file',
      name: file.name,
      extension: file.extension,
      size: file.size,
      symbol: {
        kind: symbol.kind,
        name: symbol.name,
        astRole: astRoleWeight(symbol.kind),
      },
      ruleRefs,
      fiveWOneH: {
        who,
        what: `${symbol.kind} ${symbol.name}`,
        where: `${file.path}:${symbol.lineNumber}`,
        when: 'fresh',
        why: reason,
        how: 'use this official AST symbol as the primary code structure coordinate',
      },
    },
  });
}

function producerToolForExtension(extension) {
  const lang = LanguageParser.languageForExtension(extension);
  if (lang === 'python') return 'PythonAst';
  if (lang === 'cpp') return 'ClangAst';
  if (lang === 'rust') return 'RustAnalyzer';
  return 'TypeScriptCompilerApi';
}

const AST_ROLE_WEIGHT = {
  class: 1.3,
  function: 1.25,
  const: 1.1,
  method: 1.1,
  let: 1.0,
  var: 1.0,
};

function astRoleWeight(kind) {
  return AST_ROLE_WEIGHT[kind] ?? 1.0;
}

function scoreSymbol(symbol, queryTokens) {
  const name = symbol.name.toLowerCase();
  const symbolTokens = symbolNameTokens(symbol.name);
  let base = 0;
  for (const token of queryTokens) {
    if (name === token) base += 100;
    else if (symbolTokens.includes(token)) base += 70;
    else if (name.includes(token)) base += 40;
  }
  if (base <= 0) return 0;
  return Math.round(base * astRoleWeight(symbol.kind));
}

function symbolQueryTokens(value) {
  return String(value ?? '')
    .split(/[^A-Za-z0-9_$]+/g)
    .flatMap((token) => symbolNameTokens(token))
    .filter((token) => token.length >= 3 && !AST_STOP_TOKENS.has(token));
}

function symbolNameTokens(value) {
  return String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9_$]+/g)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function compareHits(a, b) {
  return a.location.path.localeCompare(b.location.path)
    || a.location.startLine - b.location.startLine
    || a.metadata.symbol.name.localeCompare(b.metadata.symbol.name);
}
