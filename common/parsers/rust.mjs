import { spawnSync } from 'node:child_process';

import { CodebaseProjectionBuilder } from './codebase-projection-builder.mjs';
import { partialAst } from './partial-ast.mjs';

export const RUST_ANALYZER_TIMEOUT_MS = 30_000;

export class RustParser {
  static RUST_ANALYZER_TIMEOUT_MS = RUST_ANALYZER_TIMEOUT_MS;

  #content;

  #absolutePath;

  #relativePath;

  constructor({ content = '', absolutePath = '', relativePath = '' } = {}) {
    this.#content = String(content ?? '');
    this.#absolutePath = absolutePath;
    this.#relativePath = relativePath;
  }

  static parse(payload) {
    const { content, absolutePath = '', relativePath = '' } = typeof payload === 'object' && payload !== null && 'content' in payload
      ? payload
      : { content: payload };
    return new RustParser({ content, absolutePath, relativePath }).execute();
  }

  execute() {
    const filePath = this.#relativePath || this.#absolutePath || '<stdin>';
    const projection = new CodebaseProjectionBuilder(filePath);
    for (const entry of this.#extractUseStatements()) projection.addImport(entry);

    const execution = this.#runAnalyzer();
    const syntaxExecution = this.#runSyntaxDump();
    let ast = partialAst(this.#content, { language: 'rust', parser_version: 'rust-analyzer-parse-v1', rootKind: 'SOURCE_FILE' });
    const astDiagnostics = [];

    if (syntaxExecution.stdout) {
      try {
        ast = RustParser.serializeAst(syntaxExecution.stdout, this.#content);
      } catch (error) {
        astDiagnostics.push({ code: 'AST_PARSE_FAILED', message: `rust-analyzer syntax tree: ${error.message}` });
      }
    } else {
      astDiagnostics.push(syntaxExecution.diagnostic ?? { code: 'FRONTEND_UNAVAILABLE', message: 'rust-analyzer parse produced no output' });
    }

    this.#projectSymbols(projection, execution.symbols, filePath);

    return {
      ...projection.finish(),
      ast,
      diagnostics: [
        ...astDiagnostics,
        ...(ast.completeness === 'partial' ? [{ code: 'AST_PARTIAL', message: 'Rust adapter retained source-line evidence because rust-analyzer parse was unavailable.' }] : []),
        ...(execution.diagnostic ? [execution.diagnostic] : []),
      ],
    };
  }

  #projectSymbols(projection, symbols, filePath) {
    const scopeByIndex = new Map([[-1, [filePath]]]);
    for (let index = 0; index < symbols.length; index += 1) {
      const symbol = symbols[index];
      const parentPath = scopeByIndex.get(symbol.parent ?? -1) ?? [filePath];
      const line = RustParser.#offsetToLine(this.#content, symbol.navStart);
      if (['Struct', 'Enum', 'Trait', 'Union'].includes(symbol.kind)) {
        const scopePath = [...parentPath, symbol.label];
        projection.addClass({
          name: symbol.label, line, kind: symbol.kind.toLowerCase(), scopePath, parentPath,
        });
        scopeByIndex.set(index, scopePath);
      } else if (symbol.kind === 'Impl') {
        const target = symbol.label.replace(/^impl\s+(?:\w+\s+for\s+)?/, '').trim();
        scopeByIndex.set(index, [...parentPath, target]);
      } else if (['Function', 'Method'].includes(symbol.kind)) {
        const scopePath = [...parentPath, symbol.label];
        projection.addCallable({
          name: symbol.label, line, detail: symbol.detail, scopePath, parentPath, method: symbol.kind === 'Method',
        });
        scopeByIndex.set(index, scopePath);
      } else if (['Const', 'Static', 'TypeAlias'].includes(symbol.kind)) {
        projection.addVariable({ name: symbol.label, line, parentPath });
        scopeByIndex.set(index, [...parentPath, symbol.label]);
      } else if (symbol.kind === 'Module') {
        projection.addImport({ module: symbol.label, line });
        scopeByIndex.set(index, [...parentPath, symbol.label]);
      }
    }
  }

  #runAnalyzer() {
    const result = this.#runCommand(['symbols'], 'rust-analyzer', 20 * 1024 * 1024);
    return { symbols: result.diagnostic ? [] : RustParser.#parseSymbols(result.stdout), diagnostic: result.diagnostic };
  }

  #runSyntaxDump() {
    return this.#runCommand(['parse'], 'rust-analyzer parse', 100 * 1024 * 1024);
  }

  #runCommand(args, label, maxBuffer) {
    try {
      const result = spawnSync('rust-analyzer', args, {
        input: this.#content, encoding: 'utf8', timeout: RustParser.RUST_ANALYZER_TIMEOUT_MS, maxBuffer,
      });
      const diagnostic = result.error
        ? { code: result.error.code === 'ETIMEDOUT' ? 'FRONTEND_TIMEOUT' : 'FRONTEND_UNAVAILABLE', message: `${label}: ${result.error.message}` }
        : result.status !== 0
          ? { code: 'FRONTEND_FAILED', message: `${label} exited with status ${result.status}` }
          : null;
      return { stdout: result.stdout || '', diagnostic };
    } catch (error) {
      return { stdout: '', diagnostic: { code: 'FRONTEND_UNAVAILABLE', message: `${label}: ${error.message}` } };
    }
  }

  static #parseSymbols(stdout) {
    const symbols = [];
    const re = /StructureNode\s*\{\s*parent:\s*(None|Some\((\d+)\)),\s*label:\s*"([^"]+)",\s*navigation_range:\s*(\d+)\.\.\d+,\s*node_range:\s*\d+\.\.\d+,\s*kind:\s*SymbolKind\((\w+)\),\s*detail:\s*(None|Some\("([^"]*)"\))/g;
    let match = re.exec(stdout);
    while (match !== null) {
      symbols.push({
        parent: match[1] === 'None' ? null : Number.parseInt(match[2], 10), label: match[3], navStart: Number.parseInt(match[4], 10), kind: match[5], detail: match[7] ?? null,
      });
      match = re.exec(stdout);
    }
    return symbols;
  }

  #extractUseStatements() {
    return this.#content.split(/\r?\n/).flatMap((line, index) => {
      const match = line.match(/^\s*(?:pub\s+)?use\s+(.+?)\s*;/);
      if (!match) return [];
      return [{ module: match[1].replace(/\s+as\s+\w+$/, '').replace(/\{[^}]*\}$/, '').replace(/::\*$/, '').replace(/::$/, ''), line: index + 1 }];
    });
  }

  // AST Serialization
  static serializeAst(rawText, source) {
    if (typeof rawText !== 'string') throw new TypeError('rawText must be a string');
    if (typeof source !== 'string') throw new TypeError('source must be a string');
    return {
      format: 'ctx.ast.v1',
      language: 'rust',
      parser_version: 'rust-analyzer-parse-v1',
      offset_encoding: 'utf8-byte',
      completeness: 'complete',
      source_text: source,
      source_length: Buffer.byteLength(source),
      raw_text: rawText,
      root: RustParser.#parseDump(rawText, source),
    };
  }

  static #parseDump(rawText, source) {
    const stack = [];
    const roots = [];
    for (const line of rawText.split(/\r?\n/)) {
      const match = /^(\s*)([A-Z][A-Z0-9_]*)@(\d+)\.\.(\d+)(?:\s+.*)?$/.exec(line);
      if (!match) continue;
      const depth = Math.floor(match[1].length / 2);
      const node = {
        kind: match[2],
        ordinal: 0,
        field: null,
        start: Number(match[3]),
        end: Number(match[4]),
        ...RustParser.#lineFromByteOffset(source, Number(match[3])),
        text: RustParser.#sourceSlice(source, Number(match[3]), Number(match[4])),
        children: [],
      };
      while (stack.length > depth) stack.pop();
      const parent = stack.at(-1);
      if (parent) {
        node.ordinal = parent.children.length;
        node.field = 'children';
        parent.children.push(node);
      } else {
        node.ordinal = roots.length;
        roots.push(node);
      }
      stack.push(node);
    }
    return roots[0] ?? {
      kind: 'SOURCE_FILE',
      ordinal: 0,
      field: null,
      start: 0,
      end: Buffer.byteLength(source),
      line: 1,
      column: 1,
      text: source,
      children: [],
    };
  }

  static #sourceSlice(source, start, end) {
    return Buffer.from(source).subarray(start, end).toString('utf8');
  }

  static #lineFromByteOffset(source, offsetVal) {
    const prefix = RustParser.#sourceSlice(source, 0, offsetVal);
    const lineStart = prefix.lastIndexOf('\n') + 1;
    return { line: prefix.split('\n').length, column: Buffer.byteLength(prefix.slice(lineStart)) + 1 };
  }

  static #offsetToLine(content, offsetVal) {
    let line = 1;
    for (let index = 0; index < offsetVal && index < content.length; index += 1) if (content[index] === '\n') line += 1;
    return line;
  }
}
