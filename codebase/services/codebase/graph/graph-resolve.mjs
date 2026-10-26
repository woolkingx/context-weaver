export class GraphResolver {
  static resolveSymbol(session, symbol) {
    const parts = symbol.split('.');
    const rows = session.query({
      sql: `SELECT name, node_kind, structure, behavior FROM node_rows
            WHERE (json_extract(structure, '$.displayName') = ?
               OR json_extract(structure, '$.path') = ?
               OR json_extract(structure, '$.path') LIKE ?)
            ORDER BY CASE node_kind
              WHEN 'class' THEN 1 WHEN 'file' THEN 2 ELSE 3
            END
            LIMIT 5`,
      params: [parts[0], symbol, `%${symbol}`],
    });
    if (rows.length === 0) return this.resolveModuleFunction(session, symbol);
    const node = rows[0];
    const s = this.parseJson(node.structure);
    const b = this.parseJson(node.behavior);
    const resolved = {
      name: node.name,
      kind: node.node_kind,
      displayName: s.displayName ?? s.path ?? symbol,
      file: s.path ?? null,
      line: s.line ?? null,
      structure: s,
      behavior: b,
    };
    if (parts.length > 1 && b?.methods?.[parts[1]]) {
      const method = b.methods[parts[1]];
      return {
        name: `${node.name}#${parts[1]}`,
        kind: 'method',
        displayName: `${resolved.displayName}.${parts[1]}`,
        file: s.path,
        line: method.line,
        method,
        parentNode: resolved,
      };
    }
    if (parts.length > 1 && b?.functions?.[parts[1]]) {
      const fn = b.functions[parts[1]];
      return {
        name: `${node.name}#${parts[1]}`,
        kind: 'function',
        displayName: `${resolved.displayName}.${parts[1]}`,
        file: s.path,
        line: fn.line,
        method: fn,
        parentNode: resolved,
      };
    }
    return resolved;
  }

  // A module-level function is not a node of its own: it lives in the behavior of
  // the file that defines it. Resolve a bare function name through that file.
  static resolveModuleFunction(session, name) {
    const rows = session.query({
      sql: `SELECT name, node_kind, structure, behavior FROM node_rows
            WHERE node_kind = 'file'
              AND EXISTS (SELECT 1 FROM json_each(behavior, '$.functions') WHERE key = ?)
            ORDER BY json_extract(structure, '$.path')
            LIMIT 1`,
      params: [name],
    });
    if (rows.length === 0) return null;
    const structure = this.parseJson(rows[0].structure);
    const fn = this.parseJson(rows[0].behavior).functions[name];
    const displayName = structure.displayName ?? structure.path;
    return {
      name: `${rows[0].name}#${name}`,
      kind: 'function',
      displayName: `${displayName}.${name}`,
      file: structure.path,
      line: fn.line,
      method: fn,
      parentNode: {
        name: rows[0].name, kind: 'file', displayName, file: structure.path, line: null, structure, behavior: this.parseJson(rows[0].behavior),
      },
    };
  }

  static resolveFileNode(session, filePath) {
    const rows = session.query({
      sql: `SELECT name, node_kind, structure, behavior FROM node_rows
            WHERE node_kind = 'file'
              AND (json_extract(structure, '$.path') = ? OR json_extract(structure, '$.path') LIKE ?)
            LIMIT 1`,
      params: [filePath, `%${filePath}`],
    });
    if (rows.length === 0) return null;
    const s = this.parseJson(rows[0].structure);
    const b = this.parseJson(rows[0].behavior);
    return {
      name: rows[0].name,
      kind: 'file',
      displayName: s.path,
      file: s.path,
      line: null,
      structure: s,
      behavior: b,
    };
  }

  static resolveNodeByName(session, name) {
    if (!name) return null;
    const rows = session.query({
      sql: 'SELECT name, node_kind, structure, behavior FROM node_rows WHERE name = ? LIMIT 1',
      params: [name],
    });
    if (rows.length === 0) return null;
    const s = this.parseJson(rows[0].structure);
    const b = this.parseJson(rows[0].behavior);
    return {
      name: rows[0].name,
      kind: rows[0].node_kind,
      displayName: s.displayName ?? s.path,
      file: s.path,
      line: s.line,
      structure: s,
      behavior: b,
    };
  }

  static parseJson(value) {
    if (!value || typeof value !== 'string') return value ?? {};
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  static escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  static createMessage(depth, direction, symbol, kind, file, line, extra) {
    const m = {
      depth, direction, symbol, kind, file, line,
    };
    if (extra) Object.assign(m, extra);
    return m;
  }

  static msg(depth, direction, symbol, kind, file, line, extra) {
    return this.createMessage(depth, direction, symbol, kind, file, line, extra);
  }

  static createResult(flow, focus, messages, error) {
    const result = {
      object: 'GraphFlow', flow, focus, messages,
    };
    if (error) result.error = error;
    return result;
  }

  static flowResult(flow, focus, messages, error) {
    return this.createResult(flow, focus, messages, error);
  }
}

export function resolveSymbol(session, symbol) {
  return GraphResolver.resolveSymbol(session, symbol);
}

export function resolveFileNode(session, filePath) {
  return GraphResolver.resolveFileNode(session, filePath);
}

export function resolveNodeByName(session, name) {
  return GraphResolver.resolveNodeByName(session, name);
}

export function parseJson(value) {
  return GraphResolver.parseJson(value);
}

export function escapeRegex(str) {
  return GraphResolver.escapeRegex(str);
}

export function msg(depth, direction, symbol, kind, file, line, extra) {
  return GraphResolver.createMessage(depth, direction, symbol, kind, file, line, extra);
}

export function flowResult(flow, focus, messages, error) {
  return GraphResolver.createResult(flow, focus, messages, error);
}
