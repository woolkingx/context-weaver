import { JsParser } from './js.mjs';
import { PythonParser } from './python.mjs';
import { ClangParser } from './clang.mjs';
import { RustParser } from './rust.mjs';

const EXTENSION_SPEC = new Map([
  ['js', { language: 'javascript', parser: JsParser }],
  ['jsx', { language: 'javascript', parser: JsParser }],
  ['mjs', { language: 'javascript', parser: JsParser }],
  ['cjs', { language: 'javascript', parser: JsParser }],
  ['ts', { language: 'typescript', parser: JsParser }],
  ['tsx', { language: 'javascript', parser: JsParser }],
  ['py', { language: 'python', parser: PythonParser }],
  ['pyi', { language: 'python', parser: PythonParser }],
  ['rs', { language: 'rust', parser: RustParser }],
  ['c', { language: 'cpp', parser: ClangParser }],
  ['h', { language: 'cpp', parser: ClangParser }],
  ['cc', { language: 'cpp', parser: ClangParser }],
  ['cpp', { language: 'cpp', parser: ClangParser }],
  ['cxx', { language: 'cpp', parser: ClangParser }],
  ['hpp', { language: 'cpp', parser: ClangParser }],
  ['hh', { language: 'cpp', parser: ClangParser }],
]);

export class LanguageParser {
  static handlesExtension(extension) {
    return EXTENSION_SPEC.has(String(extension).toLowerCase());
  }

  static languageForExtension(extension) {
    return EXTENSION_SPEC.get(String(extension).toLowerCase())?.language ?? null;
  }

  static parserForExtension(extension) {
    return EXTENSION_SPEC.get(String(extension).toLowerCase())?.parser ?? null;
  }

  static parse(payload) {
    const {
      content,
      relativePath = '',
      absolutePath = '',
      includePaths = [],
    } = typeof payload === 'object' && payload !== null && 'content' in payload
      ? payload
      : { content: payload };

    const ext = String(relativePath || absolutePath).split('.').pop()?.toLowerCase() ?? '';
    const ParserClass = this.parserForExtension(ext);
    if (ParserClass) {
      return ParserClass.parse({
        content, relativePath, absolutePath, includePaths,
      });
    }

    const file = {
      name: `codebase:${relativePath}`,
      structure: {
        kind: 'file', path: relativePath, classes: {}, variables: {}, imports: {}, declarations: {},
      },
      behavior: { functions: {} },
    };
    return {
      nodes: [file],
      edges: [],
      diagnostics: [{ code: 'FRONTEND_UNAVAILABLE', message: `No parser admitted for .${ext || '(none)'}.` }],
    };
  }

  static extractSymbols(payload) {
    const {
      content,
      extension = '',
      relativePath = '',
      absolutePath = '',
    } = typeof payload === 'object' && payload !== null && 'content' in payload
      ? payload
      : { content: payload };

    const ext = extension || String(relativePath || absolutePath).split('.').pop()?.toLowerCase() || '';
    if (!this.handlesExtension(ext)) return [];

    const result = this.parse({ content, relativePath: relativePath || absolutePath, absolutePath });
    const lines = typeof content === 'string' ? content.split(/\r?\n/) : [];
    const symbols = [];

    for (const node of result.nodes ?? []) {
      if (node.structure?.displayName && (node.structure.kind === 'class' || node.structure.kind === 'struct' || node.structure.kind === 'enum' || node.structure.kind === 'trait' || node.structure.kind === 'union')) {
        const lineNum = Number(node.structure.line ?? 1);
        symbols.push({
          kind: node.structure.kind === 'struct' || node.structure.kind === 'trait' || node.structure.kind === 'union' ? 'class' : node.structure.kind,
          name: node.structure.displayName,
          lineNumber: lineNum,
          line: lines[lineNum - 1] ?? '',
        });
      }
      for (const fn of Object.values(node.behavior?.functions ?? {})) {
        if (fn.displayName) {
          const lineNum = Number(fn.line ?? 1);
          symbols.push({
            kind: 'function',
            name: fn.displayName,
            lineNumber: lineNum,
            line: lines[lineNum - 1] ?? '',
          });
        }
      }
      for (const method of Object.values(node.behavior?.methods ?? {})) {
        if (method.displayName) {
          const lineNum = Number(method.line ?? 1);
          symbols.push({
            kind: 'method',
            name: method.displayName,
            lineNumber: lineNum,
            line: lines[lineNum - 1] ?? '',
          });
        }
      }
      for (const scopeVars of Object.values(node.structure?.variables ?? {})) {
        for (const variable of Object.values(scopeVars ?? {})) {
          if (variable.displayName) {
            const lineNum = Number(variable.line ?? 1);
            symbols.push({
              kind: 'variable',
              name: variable.displayName,
              lineNumber: lineNum,
              line: lines[lineNum - 1] ?? '',
            });
          }
        }
      }
      for (const decl of Object.values(node.structure?.declarations ?? {})) {
        if (decl.displayName) {
          const lineNum = Number(decl.line ?? 1);
          symbols.push({
            kind: decl.kind ?? 'declaration',
            name: decl.displayName,
            lineNumber: lineNum,
            line: lines[lineNum - 1] ?? '',
          });
        }
      }
    }

    const seen = new Set();
    const deduped = symbols.filter((s) => {
      const key = `${s.kind}|${s.name}|${s.lineNumber}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return deduped.sort((a, b) => a.lineNumber - b.lineNumber || a.name.localeCompare(b.name));
  }
}
