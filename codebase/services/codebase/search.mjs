import { cacheKeyFor } from '../../db/cache-key.mjs';

const MAX_LIMIT = 200;
const MAX_TEXT = 300;

// Text search over the persisted Codebase FileBlocks: SQL filters the files that
// contain the string, and only those files are read line by line. Matching is
// case-insensitive for ASCII, because SQLite lower() is ASCII-only and the SQL
// filter and the line match must agree.
export class CodebaseSearch {
  #session;

  constructor({ session }) {
    this.#session = session;
  }

  run({
    root, query, limit, path = null,
  }) {
    const needle = String(query ?? '').trim();
    if (!needle) throw new TypeError('query is required.');
    const cap = Math.min(Math.max(Number(limit), 1), MAX_LIMIT);
    const folded = asciiLower(needle);
    const rows = this.#session.query({
      sql: `
        SELECT file_path, json_extract(value, '$.ast.source_text') AS source_text
        FROM file_blocks
        WHERE owner = 'codebase' AND cache_key = ?
          AND instr(lower(json_extract(value, '$.ast.source_text')), ?) > 0
          ${path ? "AND file_path LIKE ? ESCAPE '\\'" : ''}
        ORDER BY file_path
        LIMIT ?`,
      params: [cacheKeyFor('codebase', root), folded, ...(path ? [`${escapeLike(path)}%`] : []), cap + 1],
    });
    const hits = [];
    for (const row of rows) {
      const lines = String(row.source_text).split(/\r?\n/);
      for (let index = 0; index < lines.length && hits.length <= cap; index += 1) {
        const column = asciiLower(lines[index]).indexOf(folded);
        if (column === -1) continue;
        hits.push({
          path: row.file_path,
          line: index + 1,
          column: column + 1,
          text: lines[index].length > MAX_TEXT ? `${lines[index].slice(0, MAX_TEXT)}…` : lines[index],
        });
      }
      if (hits.length > cap) break;
    }
    return {
      object: 'SearchResult',
      root,
      query: needle,
      path: path ?? null,
      limit: cap,
      truncated: hits.length > cap,
      hits: hits.slice(0, cap),
    };
  }
}

function asciiLower(value) {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}
