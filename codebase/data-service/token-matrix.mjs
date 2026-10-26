import {
  copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync,
} from 'node:fs';
import path from 'node:path';
import { ConfigOwner } from '../../common/config/config-loader.mjs';

// 全域語義 matrix: token×token,一格一個語義相關度值 [0..1]。
// LLM 參數,全域一張,token is token,不分 project。
function defaultTokenMatrixPath(config = new ConfigOwner().resolve()) {
  migrateLegacyTokenMatrix(config.paths);
  return config.paths.tokenMatrixFile;
}

function migrateLegacyTokenMatrix(paths) {
  if (existsSync(paths.tokenMatrixFile) || !existsSync(paths.legacyTokenMatrixFile)) return false;
  mkdirSync(path.dirname(paths.tokenMatrixFile), { recursive: true });
  copyFileSync(paths.legacyTokenMatrixFile, paths.tokenMatrixFile);
  return true;
}

export class TokenMatrix {
  constructor({ file = null, legacyFile = null } = {}) {
    this.file = file ?? defaultTokenMatrixPath();
    if (file && legacyFile) migrateLegacyTokenMatrix({ tokenMatrixFile: file, legacyTokenMatrixFile: legacyFile });
  }

  load() {
    let raw;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return {
        object: 'TokenMatrix', version: '1', kind: 'semantic-relatedness', rel: {},
      };
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      copyFileSync(this.file, `${this.file}.corrupt`);
      throw new Error(`TokenMatrix JSON parse failed; corrupt file backed up to ${this.file}.corrupt`, {
        cause: error,
      });
    }
  }

  save({ matrix } = {}) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(matrix, null, 2));
  }

  // The token_weight projection: { a: { b: score } } -> [{ token_a, token_b, score }], skipping empty cells.
  rows() {
    const rows = [];
    for (const [tokenA, related] of Object.entries(this.load().rel ?? {})) {
      if (!related || typeof related !== 'object') continue;
      for (const [tokenB, score] of Object.entries(related)) {
        if (typeof score === 'number') rows.push({ token_a: tokenA, token_b: tokenB, score });
      }
    }
    return rows;
  }

  // Read 一格: a-b 的語義相關度 (對稱)
  get({ a, b } = {}) {
    const m = this.load();
    return m.rel[a]?.[b] ?? m.rel[b]?.[a] ?? 0;
  }

  // Read 一列: a 的語義關聯列 (= 字典釋義)
  row({ a, topN = 8 } = {}) {
    const m = this.load();
    const r = m.rel[a] ?? {};
    return Object.entries(r)
      .sort((x, y) => y[1] - x[1])
      .slice(0, topN)
      .map(([token, semantic]) => ({ token, semantic }));
  }

  // Create/Update 一格 (對稱寫入)
  set({ a, b, score } = {}) {
    const m = this.load();
    (m.rel[a] ??= {})[b] = score;
    (m.rel[b] ??= {})[a] = score;
    this.save({ matrix: m });
    return score;
  }

  // Delete 一格 (對稱)
  del({ a, b } = {}) {
    const m = this.load();
    const had = (m.rel[a]?.[b] !== undefined) || (m.rel[b]?.[a] !== undefined);
    if (m.rel[a]) delete m.rel[a][b];
    if (m.rel[b]) delete m.rel[b][a];
    this.save({ matrix: m });
    return had;
  }
}
