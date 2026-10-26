import { cacheKeyFor } from '../../db/cache-key.mjs';
import {
  createContextQuery,
  createRelateReport,
  createTokenReport,
  createSensorReport,
} from '../../schema/context.mjs';
import { AstSymbolSensor } from '../../sensors/ast-symbol-sensor.mjs';
import { cooccurrence, cooccurWeight } from '../../sensors/cooccurrence.mjs';
import { ContentSliceError, ContentSliceSensor } from '../../sensors/content-slice-sensor.mjs';
import { ConfigOwner } from '../../../common/config/config-loader.mjs';

export class CodebaseImplementation {
  constructor({ config = null, projectionSession = null } = {}) {
    this.config = config;
    this.projectionSession = projectionSession;
  }

  #configFor(root) {
    return this.config?.root === root ? this.config : new ConfigOwner().resolve({ root });
  }

  #contentSliceSensor(root) {
    return new ContentSliceSensor({
      globalSkillSources: this.#configFor(root).values.globalSkillRoots,
      fileOwnerForRoot: (sourceRoot) => this.#sourceOwner(sourceRoot),
    });
  }

  #sourceOwner(root) {
    if (typeof this.projectionSession?.sourceOwnerFor !== 'function') {
      const error = new Error('Codebase service requires a Unified Data Service source capability.');
      error.code = 'UNIFIED_DATA_SERVICE_REQUIRED';
      throw error;
    }
    return this.projectionSession.sourceOwnerFor(root);
  }

  #runData(root, callback) {
    if (!this.projectionSession || this.projectionSession.root !== root) {
      const error = new Error('Codebase service requires a Unified Data Service projection session.');
      error.code = 'UNIFIED_DATA_SERVICE_REQUIRED';
      throw error;
    }
    return callback(this.projectionSession.store, this.projectionSession.cacheSession);
  }

  #tokenMatrix(root) {
    if (!this.projectionSession || this.projectionSession.root !== root
      || typeof this.projectionSession.tokenMatrixFor !== 'function') {
      const error = new Error('Codebase token operations require a Unified Data Service token capability.');
      error.code = 'UNIFIED_DATA_SERVICE_REQUIRED';
      throw error;
    }
    return this.projectionSession.tokenMatrixFor();
  }

  // 混合: relate(focus) = semantic(靜態,LLM填) × cooccur(動態,即時) × ast_role(結構)
  // 解 TokenMatrix 孤島: 檢索路徑讀 semantic 值,合算 AST 與共現。
  async relate({
    token: rawToken, focus, root = process.cwd(), top, topN = 8, maxChars = 2000,
  } = {}) {
    const token = String(rawToken ?? focus ?? '').toLowerCase();
    if (!token) throw new TypeError('codebase.relate requires token.');
    const matrix = this.#tokenMatrix(root);
    const semRow = matrix.load().rel[token] ?? {};

    // 共現語料(I/O) 與 AST 掃描(I/O) 互不依賴,並行跑
    const astQuery = createContextQuery({
      query: token, root, mode: 'ast', budget: { maxHits: 40, maxChars },
    });
    const [texts, astHits] = await this.#runData(root, (fileBlockStore, cacheSession) => Promise.all([
      collectRelateTexts(root, fileBlockStore),
      AstSymbolSensor.search({ query: astQuery, fileBlockStore, cacheSession }),
    ]));
    const co = cooccurrence(texts, token);
    const astRoleByToken = new Map();
    for (const hit of astHits) {
      const sym = hit.metadata?.symbol;
      if (!sym) continue;
      for (const t of AstSymbolSensor.symbolNameTokens(sym.name)) {
        astRoleByToken.set(t, Math.max(astRoleByToken.get(t) || 1, sym.astRole || 1));
      }
    }

    const candidates = new Set([...co.keys(), ...Object.keys(semRow)]);
    const related = [];
    for (const t of candidates) {
      if (t === token) continue;
      const semantic = semRow[t] ?? 0;
      const count = co.get(t) || 0;
      const astRole = astRoleByToken.get(t) || 1;
      const base = semantic > 0 ? semantic : 0.2; // 語義沒填給低底,graph 仍可長
      const weight = base * cooccurWeight(count) * astRole;
      related.push({
        token: t, weight: Number(weight.toFixed(3)), semantic, cooccur: count, astRole,
      });
    }
    related.sort((x, y) => y.weight - x.weight);

    return createRelateReport({
      focus: token,
      root,
      related: related.slice(0, top ?? topN),
    });
  }

  async token({
    operation, sub, args = [], a: rawA, b: rawB, score: rawScore, top, topN = 8, root = process.cwd(),
  } = {}) {
    const op = operation ?? sub;
    const [argA, argB, argScore] = args;
    const a = rawA ?? argA;
    const b = rawB ?? argB;
    if (!['set', 'get', 'row', 'del'].includes(op)) throw new TypeError('token operation must be set, get, row, or del.');
    if (!a || (op !== 'row' && !b)) throw new TypeError(`token ${op} requires its declared arguments.`);
    const score = rawScore !== undefined ? rawScore : (argScore !== undefined ? Number(argScore) : undefined);
    if (op === 'set' && (!Number.isFinite(score) || score < 0 || score > 1)) throw new TypeError('token set score must be between 0 and 1.');
    const limit = top ?? topN;
    const matrix = this.#tokenMatrix(root);
    if (op === 'set') {
      return createTokenReport({
        op: 'set', a, b, semantic: matrix.set({ a, b, score }),
      });
    }
    if (op === 'del') {
      return createTokenReport({
        op: 'del', a, b, removed: matrix.del({ a, b }),
      });
    }
    if (op === 'get') {
      return createTokenReport({
        op: 'get', a, b, semantic: matrix.get({ a, b }),
      });
    }
    // row: 查一列 = 字典釋義
    return createTokenReport({ op: 'row', a, related: matrix.row({ a, topN: limit }) });
  }

  async slice({
    path: rawPath, targetPath, root = process.cwd(), start, startLine, end, endLine, maxChars = 12000,
  } = {}) {
    const target = rawPath ?? targetPath;
    if (!target) throw new TypeError('codebase.slice requires path.');
    const sLine = start ?? startLine;
    const eLine = end ?? endLine;
    const query = createContextQuery({
      intent: 'understand',
      query: target,
      question: { what: target, how: 'slice source evidence' },
      root,
      mode: 'slice',
      budget: { maxChars },
    });
    const missingContext = [];
    const expansions = [];
    let results = [];
    try {
      const result = await this.#contentSliceSensor(query.root).slice({
        query,
        path: target,
        startLine: sLine,
        endLine: eLine,
        ruleRefs: [],
      });
      results = [result];
      if (result.metadata?.nextStartLine) {
        expansions.push({
          route: 'slice',
          path: target,
          query: `${target}:${result.metadata.nextStartLine}-${result.metadata.nextEndLine ?? ''}`,
          reason: `Continue truncated slice at line ${result.metadata.nextStartLine}.`,
        });
      }
    } catch (error) {
      if (!(error instanceof ContentSliceError)) throw error;
      missingContext.push(error.message);
    }
    return createSensorReport({
      query,
      coordinate: { owner: 'codebase' },
      results,
      expansions,
      missingContext,
    });
  }
}

// 共現語料: 取 Codebase 持久化 FileBlock 中 Markdown + 源碼的文本 (有界,避免掃爆)。
// 直接以 SQL 讀取,所以快取為 fresh、記憶體中沒有 blocks 時也有語料。
const RELATE_EXTENSIONS = ['.md', '.html', '.mjs', '.js', '.json'];

function collectRelateTexts(root, fileBlockStore = null, maxFiles = 60) {
  if (!fileBlockStore) {
    const error = new Error('Relate text collection requires a Unified Data Service projection session.');
    error.code = 'UNIFIED_DATA_SERVICE_REQUIRED';
    throw error;
  }
  return fileBlockStore.query({
    sql: `
      SELECT json_extract(value, '$.ast.source_text') AS text
      FROM file_blocks
      WHERE owner = 'codebase' AND cache_key = ?
        AND (${RELATE_EXTENSIONS.map(() => 'file_path LIKE ?').join(' OR ')})
        AND length(file_path) - length(replace(file_path, '/', '')) <= 5
        AND json_type(value, '$.ast.source_text') = 'text'
      ORDER BY file_path
      LIMIT ?`,
    params: [cacheKeyFor('codebase', root), ...RELATE_EXTENSIONS.map((extension) => `%${extension}`), maxFiles],
  }).map((row) => row.text);
}
