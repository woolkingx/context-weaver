import { spawnSync } from 'node:child_process';

import { CodebaseProjectionBuilder } from './codebase-projection-builder.mjs';
import { partialAst } from './partial-ast.mjs';

export class ClangParser {
  #content;

  #absolutePath;

  #relativePath;

  #includePaths;

  constructor({
    content = '', absolutePath = '', relativePath = '', includePaths = [],
  } = {}) {
    this.#content = String(content ?? '');
    this.#absolutePath = absolutePath;
    this.#relativePath = relativePath;
    this.#includePaths = Array.isArray(includePaths) ? includePaths : [];
  }

  static parse(payload) {
    const {
      content, absolutePath = '', relativePath = '', includePaths = [],
    } = typeof payload === 'object' && payload !== null && 'content' in payload
      ? payload
      : { content: payload };
    return new ClangParser({
      content, absolutePath, relativePath, includePaths,
    }).execute();
  }

  execute() {
    const filePath = this.#relativePath || this.#absolutePath || '<stdin>';
    const ext = filePath.replace(/^.*\./, '').toLowerCase();
    const projection = new CodebaseProjectionBuilder(filePath);
    for (const include of this.#extractIncludes()) projection.addImport(include);

    const jsonExecution = this.#runClangDump(ext);
    const language = ext === 'c' ? 'c' : 'c++';
    let ast = partialAst(this.#content, { language, parser_version: 'clang-ast-json-v1' });
    const astDiagnostics = [];

    if (jsonExecution.stdout) {
      try {
        const rawJson = JSON.parse(jsonExecution.stdout);
        ast = ClangParser.serializeAst(rawJson, this.#content, { language });
        this.#walkJsonAst(rawJson, {
          projection,
          content: this.#content,
          sourceFile: this.#absolutePath || '<stdin>',
          parentPath: [filePath],
          callerPath: null,
          inCurrentFile: true,
        });
      } catch (error) {
        astDiagnostics.push({ code: 'AST_PARSE_FAILED', message: `clang JSON AST: ${error.message}` });
      }
    } else {
      astDiagnostics.push(jsonExecution.diagnostic ?? { code: 'FRONTEND_UNAVAILABLE', message: 'clang JSON AST produced no output' });
    }

    return {
      ...projection.finish(),
      ast,
      diagnostics: [
        ...astDiagnostics,
        ...(jsonExecution.diagnostic ? [jsonExecution.diagnostic] : []),
        ...(ast.completeness === 'partial' ? [ClangParser.#partialDiagnostic()] : []),
      ],
    };
  }

  #walkJsonAst(node, context) {
    if (!node || typeof node !== 'object') return;
    let currentFile = context.inCurrentFile;
    if (node.loc?.includedFrom) currentFile = false;
    else if (node.loc?.file) currentFile = (node.loc.file === context.sourceFile || node.loc.file === '<stdin>');

    if (!currentFile || node.isImplicit) {
      if (!currentFile) return;
    }

    const line = ClangParser.#nodeLine(node, context.content);
    const { parentPath, callerPath } = context;

    if (node.kind === 'NamespaceDecl' && node.name && !node.name.startsWith('__')) {
      const scopePath = [...parentPath, node.name];
      context.projection.addDeclaration({ name: node.name, line, kind: 'namespace' });
      for (const child of node.inner ?? []) {
        this.#walkJsonAst(child, { ...context, parentPath: scopePath, inCurrentFile: currentFile });
      }
      return;
    }

    if ((node.kind === 'CXXRecordDecl' || node.kind === 'RecordDecl') && node.name && !node.name.startsWith('__')) {
      const scopePath = [...parentPath, node.name];
      context.projection.addClass({
        name: node.name, line, scopePath, parentPath,
      });
      for (const child of node.inner ?? []) {
        this.#walkJsonAst(child, { ...context, parentPath: scopePath, inCurrentFile: currentFile });
      }
      return;
    }

    if (['FunctionDecl', 'CXXMethodDecl', 'CXXConstructorDecl', 'CXXDestructorDecl'].includes(node.kind) && node.name && !node.name.startsWith('__')) {
      const scopePath = [...parentPath, node.name];
      const sig = node.type?.qualType ?? '';
      context.projection.addCallable({
        name: node.name, line, detail: sig, scopePath, parentPath, method: node.kind !== 'FunctionDecl',
      });
      for (const child of node.inner ?? []) {
        this.#walkJsonAst(child, {
          ...context, parentPath: scopePath, callerPath: scopePath, inCurrentFile: currentFile,
        });
      }
      return;
    }

    if ((node.kind === 'CallExpr' || node.kind === 'CXXMemberCallExpr') && callerPath) {
      const callee = ClangParser.#extractCallee(node.inner?.[0]);
      if (callee) {
        context.projection.addCall({ callee, line, callerPath });
      }
    }

    if (node.kind === 'VarDecl' && node.name && !node.name.startsWith('__')) {
      context.projection.addVariable({ name: node.name, line, parentPath });
    }

    if (node.kind === 'EnumDecl' && node.name && !node.name.startsWith('__')) {
      const scopePath = [...parentPath, node.name];
      context.projection.addClass({
        name: node.name, line, kind: 'enum', scopePath, parentPath,
      });
      for (const child of node.inner ?? []) {
        this.#walkJsonAst(child, { ...context, parentPath: scopePath, inCurrentFile: currentFile });
      }
      return;
    }

    if ((node.kind === 'TypedefDecl' || node.kind === 'TypeAliasDecl') && node.name && !node.name.startsWith('__')) {
      context.projection.addVariable({ name: node.name, line, parentPath });
    }

    for (const child of node.inner ?? []) {
      this.#walkJsonAst(child, { ...context, inCurrentFile: currentFile });
    }
  }

  static #extractCallee(node) {
    if (!node) return null;
    if (node.kind === 'MemberExpr') {
      const receiver = node.inner?.[0]?.referencedDecl?.name || (node.inner?.[0]?.kind === 'CXXThisExpr' ? 'this' : null);
      return { name: node.name, receiver, qualified: receiver ? `${receiver}.${node.name}` : `member.${node.name}` };
    }
    if (node.kind === 'DeclRefExpr') {
      const name = node.referencedDecl?.name || node.name;
      if (name && !name.startsWith('__')) return { name, receiver: null, qualified: name };
    }
    for (const child of node.inner ?? []) {
      const found = ClangParser.#extractCallee(child);
      if (found) return found;
    }
    return null;
  }

  #extractIncludes() {
    return this.#content.split(/\r?\n/).flatMap((line, index) => {
      const match = line.match(/^\s*#\s*include\s+[<"]([^>"]+)[>"]/);
      return match ? [{ module: match[1], line: index + 1 }] : [];
    });
  }

  #runClangDump(ext) {
    const lang = ext === 'c' ? 'c' : 'c++';
    const compiler = lang === 'c' ? 'clang' : 'clang++';
    const stdFlag = lang === 'c' ? '-std=c11' : '-std=c++17';
    const label = `${compiler} JSON AST`;
    const args = ['-x', lang, stdFlag, '-Xclang', '-ast-dump=json', '-fsyntax-only', '-fno-color-diagnostics'];
    for (const includePath of this.#includePaths) args.push('-I', includePath);
    args.push(this.#absolutePath || '-');
    try {
      const result = spawnSync(compiler, args, {
        input: this.#absolutePath ? undefined : this.#content, encoding: 'utf8', timeout: 10000, maxBuffer: 300 * 1024 * 1024,
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

  // AST Serialization
  static serializeAst(rawJson, source, { language = 'c++' } = {}) {
    if (!rawJson || typeof rawJson !== 'object') throw new TypeError('rawJson must be an object');
    if (typeof source !== 'string') throw new TypeError('source must be a string');
    return {
      format: 'ctx.ast.v1',
      language,
      parser_version: 'clang-ast-json-v1',
      offset_encoding: 'utf8-byte',
      completeness: 'complete',
      source_text: source,
      source_length: Buffer.byteLength(source),
      raw: rawJson,
      root: ClangParser.#projectNode(rawJson, source, 0, null),
    };
  }

  static #projectNode(node, source, ordinal, field) {
    const range = node.range ?? {};
    const start = ClangParser.#offset(range.begin?.offset);
    const end = ClangParser.#offset(range.end?.offset);
    const position = ClangParser.#sourcePosition(source, start);
    const children = Array.isArray(node.inner)
      ? node.inner.map((child, index) => ClangParser.#projectNode(child, source, index, 'inner'))
      : [];
    return {
      kind: String(node.kind ?? 'Unknown'),
      ordinal,
      field,
      start,
      end,
      line: position?.line ?? null,
      column: position?.column ?? null,
      values: ClangParser.#withoutInner(node),
      ...(children.length ? { children } : { text: ClangParser.#sourceSlice(source, start, end) }),
    };
  }

  static #withoutInner(node) {
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'inner'));
  }

  static #offset(value) {
    return Number.isInteger(value) ? value : null;
  }

  static #sourceSlice(source, start, end) {
    if (start === null || end === null) return null;
    return Buffer.from(source).subarray(start, end).toString('utf8');
  }

  static #sourcePosition(source, offsetVal) {
    if (offsetVal === null) return null;
    const prefix = ClangParser.#sourceSlice(source, 0, offsetVal);
    return {
      line: prefix.split('\n').length,
      column: Buffer.byteLength(prefix.slice(prefix.lastIndexOf('\n') + 1)) + 1,
    };
  }

  static #nodeLine(node, content) {
    if (node.loc?.line != null) return Number(node.loc.line);
    if (node.loc?.spellingLoc?.line != null) return Number(node.loc.spellingLoc.line);
    if (node.range?.begin?.line != null) return Number(node.range.begin.line);
    if (node.loc?.offset != null && typeof content === 'string') {
      return ClangParser.#offsetToLine(content, node.loc.offset);
    }
    return 1;
  }

  static #offsetToLine(content, offsetVal) {
    let line = 1;
    for (let index = 0; index < offsetVal && index < content.length; index += 1) {
      if (content[index] === '\n') line += 1;
    }
    return line;
  }

  static #partialDiagnostic() {
    return { code: 'AST_PARTIAL', message: 'Clang adapter retains source-line evidence and selected declarations; a lossless AST serializer is not yet available.' };
  }
}
