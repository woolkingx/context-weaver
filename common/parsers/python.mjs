import { spawnSync } from 'node:child_process';

import { CodebaseProjectionBuilder } from './codebase-projection-builder.mjs';

export class PythonParser {
  static #SCRIPT = String.raw`
import ast, json, sys

source = sys.stdin.read()
filename = sys.argv[1] if len(sys.argv) > 1 else "<stdin>"
tree = ast.parse(source, filename=filename)
events = []

def ast_value(value):
    if isinstance(value, ast.AST): return None
    if isinstance(value, list): return [ast_value(item) for item in value if not isinstance(item, ast.AST)]
    if value is None or isinstance(value, (str, int, float, bool)): return value
    return str(value)

def serialize(node, ordinal=0, field=None):
    children = []
    values = {}
    for name, value in ast.iter_fields(node):
        if isinstance(value, ast.AST):
            children.append(serialize(value, len(children), name))
        elif isinstance(value, list):
            values[name] = []
            for item in value:
                if isinstance(item, ast.AST):
                    children.append(serialize(item, len(children), name))
                    values[name].append({"child": len(children) - 1})
                else:
                    values[name].append(ast_value(item))
        else:
            values[name] = ast_value(value)
    return {"kind": type(node).__name__, "ordinal": ordinal,
            "field": field, "line": getattr(node, "lineno", None),
            "column": (getattr(node, "col_offset", None) + 1) if hasattr(node, "col_offset") else None,
            "end_line": getattr(node, "end_lineno", None),
            "end_column": (getattr(node, "end_col_offset", None) + 1) if hasattr(node, "end_col_offset") else None,
            "values": values, "children": children}

def line(n): return getattr(n, "lineno", 1) or 1
def callee_name(n):
    if isinstance(n, ast.Name): return n.id
    if isinstance(n, ast.Attribute): return n.attr
    if isinstance(n, ast.Call): return callee_name(n.func)
    return None
def callee_info(n):
    if isinstance(n, ast.Name):
        return {"name": n.id, "receiver": None, "qualified": n.id}
    if isinstance(n, ast.Attribute):
        parent = callee_info(n.value)
        if not parent: return None
        return {"name": n.attr, "receiver": parent["qualified"], "qualified": parent["qualified"] + "." + n.attr}
    if isinstance(n, ast.Call): return callee_info(n.func)
    return None

class Walker(ast.NodeVisitor):
    def __init__(self): self.stack = [filename]
    def visit_ClassDef(self, node):
        scope = self.stack + [node.name]
        events.append({"event":"class", "name":node.name, "line":line(node), "scopePath":scope, "parentPath":self.stack[:], "bases":[n for n in (callee_name(b) for b in node.bases or []) if n]})
        self.stack.append(node.name); self.generic_visit(node); self.stack.pop()
    def visit_FunctionDef(self, node):
        scope = self.stack + [node.name]
        events.append({"event":"callable", "name":node.name, "line":line(node), "scopePath":scope, "parentPath":self.stack[:], "method":len(self.stack) > 1})
        self.stack.append(node.name); self.generic_visit(node); self.stack.pop()
    def visit_AsyncFunctionDef(self, node): self.visit_FunctionDef(node)
    def visit_Import(self, node):
        for alias in node.names: events.append({"event":"import", "module":alias.name, "line":line(node)})
    def visit_ImportFrom(self, node):
        module = node.module or ""
        for alias in node.names or []: events.append({"event":"import", "module":f"{module}.{alias.name}".strip("."), "line":line(node)})
    def visit_Call(self, node):
        callee = callee_info(node.func)
        if callee and len(self.stack) > 1: events.append({"event":"call", "callee":callee, "callerPath":self.stack[:], "line":line(node)})
        self.generic_visit(node)

Walker().visit(tree)
print(json.dumps({"events": events, "ast": {"format": "ctx.ast.v1", "language": "python",
    "parser_version": "python-ast-v1", "representation": "cpython-ast-json-v1", "offset_encoding": "utf8-byte",
    "source_text": source, "source_length": len(source.encode("utf-8")), "root": serialize(tree)}}))
`;

  #content;

  #absolutePath;

  #relativePath;

  constructor({ content = '', absolutePath = '<stdin>', relativePath = '' } = {}) {
    this.#content = String(content ?? '');
    this.#absolutePath = absolutePath;
    this.#relativePath = relativePath;
  }

  static parse(payload) {
    const { content, absolutePath = '<stdin>', relativePath = '' } = typeof payload === 'object' && payload !== null && 'content' in payload
      ? payload
      : { content: payload };
    return new PythonParser({ content, absolutePath, relativePath }).execute();
  }

  execute() {
    const filePath = this.#relativePath || this.#absolutePath;
    const projection = new CodebaseProjectionBuilder(filePath);
    try {
      const result = this.#runScript(filePath);
      if (result.status !== 0) {
        return {
          ...projection.finish(),
          diagnostics: [{ code: 'FRONTEND_FAILED', message: result.stderr?.trim() || 'python ast.parse failed' }],
        };
      }
      const payload = JSON.parse(result.stdout);
      PythonParser.#projectEvents(projection, payload.events ?? []);
      return { ...projection.finish(), ast: payload.ast };
    } catch (error) {
      return {
        ...projection.finish(),
        diagnostics: [{ code: 'FRONTEND_FAILED', message: `python ast frontend: ${error.message}` }],
      };
    }
  }

  #runScript(filePath) {
    return spawnSync('python3', ['-c', PythonParser.#SCRIPT, filePath], {
      input: this.#content, encoding: 'utf8', timeout: 5000, maxBuffer: 10 * 1024 * 1024,
    });
  }

  static #projectEvents(projection, events) {
    for (const event of events) {
      if (event.event === 'class') {
        projection.addClass({
          name: event.name, line: event.line, scopePath: event.scopePath, parentPath: event.parentPath,
        });
        for (const baseName of event.bases) {
          projection.addBase({ classPath: event.scopePath, baseName, line: event.line });
        }
      } else if (event.event === 'callable') {
        projection.addCallable({
          name: event.name, line: event.line, scopePath: event.scopePath, parentPath: event.parentPath, method: event.method,
        });
      } else if (event.event === 'import') {
        projection.addImport({ module: event.module, line: event.line });
      } else if (event.event === 'call') {
        projection.addCall({ callee: event.callee, callerPath: event.callerPath, line: event.line });
      }
    }
  }
}
