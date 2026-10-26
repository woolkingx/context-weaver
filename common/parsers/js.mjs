import ts from './typescript.mjs';

export class JsParser {
  #content;

  #relativePath;

  #sourceFile = null;

  #lines = [];

  #file = null;

  #nodes = [];

  #edges = [];

  #callables = new Map();

  #objectScopes = new Set();

  #pendingCalls = [];

  #pendingExports = [];

  #exportTargets = new Map();

  #externalNodes = new Map();

  #callSequence = 0;

  constructor(content, { relativePath = '' } = {}) {
    this.#content = String(content ?? '');
    this.#relativePath = relativePath;
  }

  static parse(payload) {
    const { content, relativePath = '' } = typeof payload === 'object' && payload !== null && 'content' in payload
      ? payload
      : { content: payload };
    return new JsParser(content, { relativePath }).execute();
  }

  execute() {
    const ext = this.#relativePath.replace(/^.*\./, '');
    this.#sourceFile = ts.createSourceFile(
      `source.${ext || 'js'}`,
      this.#content,
      ts.ScriptTarget.Latest,
      true,
      JsParser.scriptKind(ext),
    );
    this.#lines = this.#content.split(/\r?\n/);
    this.#file = {
      name: `codebase:${this.#relativePath}`,
      structure: {
        kind: 'file', path: this.#relativePath, classes: {}, variables: {}, imports: {}, exports: {}, reexports: {},
      },
      behavior: { functions: {} },
    };
    this.#nodes = [this.#file];

    this.#walk(this.#sourceFile);
    this.#resolvePendingCalls();
    this.#resolvePendingExports();

    return {
      nodes: this.#nodes,
      edges: this.#edges,
      ast: JsParser.serializeAst(this.#sourceFile),
    };
  }

  #line(node) {
    return this.#sourceFile.getLineAndCharacterOfPosition(node.getStart(this.#sourceFile)).line + 1;
  }

  #excerpt(node) {
    const number = this.#line(node);
    return `${number}: ${this.#lines[number - 1] ?? ''}`;
  }

  #classNode(declaration, owner, scopePath) {
    const displayName = JsParser.declName(declaration.name);
    if (!displayName) return null;
    const key = JsParser.pathKey(displayName);
    const name = `codebase:${this.#relativePath}:class:${JsParser.pathKey(displayName)}:${JsParser.scopeAddress(scopePath.slice(1))}:L${this.#line(declaration)}`;
    const node = {
      name,
      structure: {
        kind: 'class',
        displayName,
        path: this.#relativePath,
        line: this.#line(declaration),
        excerpt: this.#excerpt(declaration),
        properties: {},
        variables: {},
      },
      behavior: { methods: {} },
    };
    this.#objectScopes.add(JsParser.scopeKey(scopePath));
    const collection = owner === this.#file ? owner.structure.classes : owner.structure.properties;
    const surface = owner === this.#file ? 'structure.classes' : 'structure.properties';
    collection[key] = { node: name, line: this.#line(declaration) };
    this.#nodes.push(node);
    this.#edges.push({
      frompath: `${owner.name}#${surface}.${key}`,
      topath: `${name}#structure`,
      kind: 'contains',
    });
    if (owner === this.#file) {
      for (const exportedName of JsParser.exportedNames(declaration, displayName)) {
        this.#rememberExport(exportedName, { nodeName: name, path: 'structure' });
      }
    }
    return node;
  }

  #registerCallable(owner, displayName, declaration, kind, scopePath, parentContext) {
    const collection = parentContext ? 'nested' : (kind === 'method' ? 'methods' : 'functions');
    const target = parentContext ? (parentContext.contract.nested ??= {}) : (owner.behavior[collection] ??= {});
    const baseKey = JsParser.pathKey(displayName);
    const key = Object.hasOwn(target, baseKey)
      ? `${baseKey}_L${this.#line(declaration)}`
      : baseKey;
    const contract = {
      kind,
      displayName,
      line: this.#line(declaration),
      excerpt: this.#excerpt(declaration),
      input: {},
      output: {},
      calls: {},
    };
    for (const parameter of declaration.parameters ?? []) {
      const parameterName = JsParser.bindingName(parameter.name);
      if (parameterName) contract.input[JsParser.pathKey(parameterName)] = { displayName: parameterName };
    }
    target[key] = contract;
    const locator = {
      nodeName: owner.name,
      path: parentContext ? `${parentContext.path}.nested.${key}` : `behavior.${collection}.${key}`,
      contract,
      scopePath,
    };
    const identity = JsParser.scopeKey(scopePath);
    this.#callables.set(identity, this.#callables.has(identity) ? null : locator);
    if (owner === this.#file && !parentContext) {
      for (const exportedName of JsParser.exportedNames(declaration, displayName)) {
        this.#rememberExport(exportedName, locator);
      }
    }
    return locator;
  }

  #rememberExport(exportedName, target) {
    if (!exportedName || !target) return;
    this.#file.structure.exports[JsParser.pathKey(exportedName)] = {
      displayName: exportedName,
      node: target.nodeName,
      path: target.path,
    };
    this.#exportTargets.set(exportedName, target);
  }

  #addVariable(owner, declaration, scope = null) {
    const displayName = JsParser.bindingName(declaration.name);
    if (!displayName) return;
    const variableScope = scope
      ? (scope.path.includes('.nested.') ? `scope_${JsParser.scopeAddress(scope.scopePath)}` : JsParser.pathKey(scope.path.replace(/^behavior\./, '')))
      : 'module';
    owner.structure.variables[variableScope] ??= {};
    owner.structure.variables[variableScope][JsParser.pathKey(displayName)] = {
      displayName,
      line: this.#line(declaration),
      excerpt: this.#excerpt(declaration),
    };
  }

  #addCall(context, node) {
    const callee = JsParser.exprTarget(node.expression);
    if (!callee) return;
    const key = `call${this.#callSequence += 1}`;
    context.contract.calls[key] = {
      callee: callee.qualified,
      line: this.#line(node),
      args: [...(node.arguments ?? [])].map((argument, index) => ({
        index,
        expression: JsParser.exprName(argument) ?? argument.getText(this.#sourceFile),
      })),
    };
    this.#pendingCalls.push({
      callee,
      frompath: `${context.nodeName}#${context.path}.calls.${key}`,
      callerScopePath: context.scopePath,
    });
  }

  #addReturn(context, node) {
    context.contract.output.return = {
      line: this.#line(node),
      expression: node.expression?.getText(this.#sourceFile) ?? null,
    };
    if (node.expression && ts.isObjectLiteralExpression(node.expression)) {
      context.contract.output.properties = {};
      for (const property of node.expression.properties) {
        const displayName = JsParser.propName(property.name);
        if (displayName) {
          context.contract.output.properties[JsParser.pathKey(displayName)] = {
            displayName,
            line: this.#line(property),
          };
        }
      }
    }
  }

  #walk(node, owner = this.#file, context = null, scopePath = [this.#relativePath]) {
    if (ts.isClassDeclaration(node)) {
      const displayName = JsParser.declName(node.name);
      const classScopePath = displayName ? [...scopePath, displayName] : scopePath;
      const object = this.#classNode(node, owner, classScopePath);
      if (object) {
        for (const member of node.members) this.#walk(member, object, null, classScopePath);
        return;
      }
    }

    if (ts.isPropertyDeclaration(node) && owner !== this.#file) {
      const displayName = JsParser.propName(node.name);
      if (displayName) {
        owner.structure.properties[JsParser.pathKey(displayName)] = {
          displayName,
          line: this.#line(node),
          excerpt: this.#excerpt(node),
        };
      }
    }

    if (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
      const displayName = ts.isConstructorDeclaration(node) ? 'constructor' : JsParser.propName(node.name);
      if (displayName) {
        const callableScopePath = [...scopePath, displayName];
        const callable = this.#registerCallable(owner, displayName, node, 'method', callableScopePath, context);
        if (node.body) this.#walk(node.body, owner, callable, callableScopePath);
        return;
      }
    }

    if (ts.isFunctionDeclaration(node)) {
      const displayName = JsParser.declName(node.name);
      if (displayName) {
        const callableScopePath = [...scopePath, displayName];
        const callable = this.#registerCallable(owner, displayName, node, owner === this.#file && !context ? 'function' : 'method', callableScopePath, context);
        if (node.body) this.#walk(node.body, owner, callable, callableScopePath);
        return;
      }
    }

    if (ts.isVariableDeclaration(node)) {
      const dynamicImport = JsParser.dynamicImportBindings(node);
      if (dynamicImport) this.#recordModuleImport(dynamicImport.module, dynamicImport.bindings, this.#line(node));
      const displayName = JsParser.bindingName(node.name);
      const isCallable = node.initializer && (
        ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)
      );
      if (displayName && isCallable) {
        const callableScopePath = [...scopePath, displayName];
        const callable = this.#registerCallable(owner, displayName, node.initializer, owner === this.#file && !context ? 'function' : 'method', callableScopePath, context);
        this.#walk(node.initializer.body, owner, callable, callableScopePath);
        return;
      }
      this.#addVariable(owner, node, context);
    }

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const target = JsParser.moduleSpecifier(node.moduleSpecifier);
      if (target) {
        this.#recordModuleImport(target, ts.isImportDeclaration(node) ? JsParser.importBindings(node) : {}, this.#line(node));
        if (ts.isExportDeclaration(node)) {
          const elements = node.exportClause?.elements ?? [];
          if (elements.length === 0) {
            this.#file.structure.reexports.star = { displayName: '*', module: target, imported: '*' };
          }
          for (const element of elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            const exported = element.name.text;
            this.#file.structure.reexports[JsParser.pathKey(exported)] = { displayName: exported, module: target, imported };
          }
        }
      } else if (ts.isExportDeclaration(node)) {
        for (const element of node.exportClause?.elements ?? []) {
          this.#pendingExports.push({
            local: element.propertyName?.text ?? element.name.text,
            exported: element.name.text,
          });
        }
      }
    }

    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      this.#pendingExports.push({ local: node.expression.text, exported: 'default' });
    }

    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && context) this.#addCall(context, node);
    if (ts.isReturnStatement(node) && context) this.#addReturn(context, node);

    ts.forEachChild(node, (child) => this.#walk(child, owner, context, scopePath));
  }

  #ensureExternal(identity, kind, method) {
    const name = `external:${kind}:${JsParser.addressKey(identity)}`;
    if (!this.#externalNodes.has(name)) {
      const node = {
        name,
        structure: { kind, displayName: identity },
        behavior: { [method]: {} },
      };
      this.#externalNodes.set(name, node);
      this.#nodes.push(node);
    }
    return this.#externalNodes.get(name);
  }

  #recordModuleImport(target, bindings = {}, importLine = 1) {
    const key = JsParser.addressKey(target);
    const existing = this.#file.structure.imports[key] ?? { module: target, line: importLine, bindings: {} };
    Object.assign(existing.bindings, bindings);
    this.#file.structure.imports[key] = existing;
    const external = this.#ensureExternal(`module:${target}`, 'external_module', 'access');
    const frompath = `${this.#file.name}#structure.imports.${key}`;
    if (!this.#edges.some((edge) => edge.frompath === frompath && edge.topath === `${external.name}#behavior.access`)) {
      this.#edges.push({ frompath, topath: `${external.name}#behavior.access`, kind: 'imports' });
    }
  }

  #resolvePendingCalls() {
    for (const call of this.#pendingCalls) {
      const target = JsParser.resolveLocal(call.callerScopePath, call.callee, this.#callables, this.#objectScopes);
      if (target) {
        this.#edges.push({ frompath: call.frompath, topath: `${target.nodeName}#${target.path}`, kind: 'calls' });
      } else {
        const external = this.#ensureExternal(`symbol:${call.callee.qualified}`, 'external_symbol', 'invoke');
        this.#edges.push({ frompath: call.frompath, topath: `${external.name}#behavior.invoke`, kind: 'calls' });
      }
    }
  }

  #resolvePendingExports() {
    for (const pending of this.#pendingExports) {
      const target = this.#exportTargets.get(pending.local);
      if (target) this.#rememberExport(pending.exported, target);
    }
  }

  // AST Serialization
  static serializeAst(sourceFile) {
    if (!sourceFile || !ts.isSourceFile(sourceFile)) throw new TypeError('sourceFile must be a TypeScript SourceFile');
    return {
      format: 'ctx.ast.v1',
      language: 'typescript',
      parser_version: 'typescript-compiler-api-v1',
      representation: 'typescript-compiler-ast-json-v1',
      source_text: sourceFile.text,
      source_length: sourceFile.text.length,
      root: JsParser.#serializeNode(sourceFile, sourceFile, 0),
    };
  }

  static #serializeNode(node, sourceFile, ordinal, field = null) {
    const start = node.getStart(sourceFile);
    const position = sourceFile.getLineAndCharacterOfPosition(start);
    const entries = Object.entries(node);
    const properties = {};
    const childEntries = [];
    for (const [key, value] of entries) {
      if (key === 'parent' || key === 'symbol' || key === 'locals' || key === 'nextContainer') continue;
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) properties[key] = value;
      else if (value && typeof value === 'object') childEntries.push([key, value]);
    }
    const children = node.getChildren(sourceFile).map((child, index) => (
      JsParser.#serializeNode(child, sourceFile, index, JsParser.#childField(childEntries, child))
    ));
    return {
      kind: ts.SyntaxKind[node.kind],
      kindId: node.kind,
      start,
      end: node.getEnd(),
      line: position.line + 1,
      column: position.character + 1,
      ordinal,
      field,
      properties,
      ...(children.length === 0 ? { text: sourceFile.text.slice(start, node.getEnd()) } : {}),
      children,
    };
  }

  static #childField(childEntries, child) {
    for (const [key, value] of childEntries) {
      if (value === child || (Array.isArray(value) && value.includes(child))) return key;
    }
    return null;
  }

  static declName(name) {
    return name?.escapedText ? String(name.escapedText) : null;
  }

  static propName(name) {
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return String(name.escapedText);
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return String(name.text);
    return null;
  }

  static bindingName(name) {
    return ts.isIdentifier(name) ? String(name.escapedText) : null;
  }

  static moduleSpecifier(spec) {
    return spec && ts.isStringLiteral(spec) ? spec.text : null;
  }

  static importBindings(node) {
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) return {};
    const bindings = {};
    if (clause.name) bindings[String(clause.name.escapedText)] = 'default';
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bindings[String(clause.namedBindings.name.escapedText)] = '*';
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        const local = String(element.name.escapedText);
        const imported = String((element.propertyName ?? element.name).escapedText);
        bindings[local] = imported;
      }
    }
    return bindings;
  }

  static dynamicImportBindings(node) {
    const initializer = node?.initializer;
    const call = initializer && ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
    if (!call || !ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
    const module = JsParser.moduleSpecifier(call.arguments?.[0]);
    if (!module) return null;
    if (ts.isObjectBindingPattern(node.name)) {
      const bindings = {};
      for (const element of node.name.elements) {
        if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
        const local = String(element.name.escapedText);
        const imported = element.propertyName && ts.isIdentifier(element.propertyName)
          ? String(element.propertyName.escapedText)
          : local;
        bindings[local] = imported;
      }
      return { module, bindings };
    }
    const local = JsParser.bindingName(node.name);
    return local ? { module, bindings: { [local]: '*' } } : null;
  }

  static exportedNames(node, displayName) {
    const modifiers = node?.modifiers ?? node?.parent?.parent?.parent?.modifiers ?? [];
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
    return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? ['default'] : [displayName];
  }

  static exprName(expr) {
    if (!expr) return null;
    if (ts.isIdentifier(expr) || ts.isPrivateIdentifier(expr)) return String(expr.escapedText);
    if (ts.isPropertyAccessExpression(expr)) return JsParser.exprName(expr.name);
    if (ts.isElementAccessExpression(expr)) return JsParser.exprName(expr.argumentExpression);
    if (ts.isCallExpression(expr)) return JsParser.exprName(expr.expression);
    return null;
  }

  static exprTarget(expr) {
    if (!expr) return null;
    if (ts.isIdentifier(expr) || ts.isPrivateIdentifier(expr)) {
      const name = String(expr.escapedText);
      return { name, receiver: null, qualified: name };
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const parent = JsParser.exprTarget(expr.expression);
      const name = JsParser.propName(expr.name);
      if (!name) return null;
      const receiver = parent?.qualified ?? expr.expression.getText();
      return { name, receiver, qualified: `${receiver}.${name}` };
    }
    if (ts.isElementAccessExpression(expr)) {
      const parent = JsParser.exprTarget(expr.expression);
      const name = JsParser.propName(expr.argumentExpression) ?? expr.argumentExpression?.getText() ?? 'member';
      const receiver = parent?.qualified ?? expr.expression.getText();
      return { name, receiver, qualified: `${receiver}.${name}` };
    }
    if (ts.isNewExpression(expr)) return JsParser.exprTarget(expr.expression);
    if (ts.isCallExpression(expr)) return JsParser.exprTarget(expr.expression);
    return null;
  }

  static resolveLocal(callerScopePath, callee, callables, objectScopes) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(callee.name)) return null;
    if (callee.receiver) {
      if (callee.receiver !== 'this') return null;
      for (let { length } = callerScopePath; length > 0; length -= 1) {
        const ownerScope = callerScopePath.slice(0, length);
        if (!objectScopes.has(JsParser.scopeKey(ownerScope))) continue;
        return callables.get(JsParser.scopeKey([...ownerScope, callee.name])) ?? null;
      }
      return null;
    }
    for (let { length } = callerScopePath; length > 0; length -= 1) {
      const identity = JsParser.scopeKey([...callerScopePath.slice(0, length), callee.name]);
      if (callables.has(identity)) return callables.get(identity);
    }
    return null;
  }

  static scopeKey(scopePath) {
    return scopePath.map((value) => `s_${JsParser.addressKey(value)}`).join('.');
  }

  static scopeAddress(scopePath) {
    return JsParser.scopeKey(scopePath);
  }

  static pathKey(value) {
    const key = String(value ?? '')
      .replace(/[^A-Za-z0-9_$:-]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return key || 'anonymous';
  }

  static addressKey(value) {
    return Buffer.from(String(value), 'utf8').toString('base64url');
  }

  static scriptKind(ext) {
    switch (String(ext).toLowerCase()) {
      case 'jsx': return ts.ScriptKind.JSX;
      case 'ts': return ts.ScriptKind.TS;
      case 'tsx': return ts.ScriptKind.TSX;
      case 'json': return ts.ScriptKind.JSON;
      default: return ts.ScriptKind.JS;
    }
  }
}
