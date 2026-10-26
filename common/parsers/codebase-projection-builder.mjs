// Builds an in-memory source projection for one FileBlock. This is a
// transient producer helper; it owns neither storage nor a semantic module.
export class CodebaseProjectionBuilder {
  constructor(relativePath) {
    this.relativePath = relativePath;
    this.fileScope = [relativePath];
    this.file = {
      name: `codebase:${relativePath}`,
      structure: {
        kind: 'file', path: relativePath, classes: {}, variables: {}, imports: {}, declarations: {},
      },
      behavior: { functions: {} },
    };
    this.nodes = [this.file];
    this.edges = [];
    this.objects = new Map([[scopeKey(this.fileScope), { node: this.file, scopePath: this.fileScope }]]);
    this.callables = new Map();
    this.external = new Map();
    this.pendingCalls = [];
    this.callSequence = 0;
  }

  addClass({
    name, line = 1, kind = 'class', detail = null, scopePath, parentPath,
  }) {
    const scope = this.#scopePath({ name, scopePath, parentPath });
    const parent = this.#nearestObject(CodebaseProjectionBuilder.#parentPath(scope, parentPath));
    const nodeName = `codebase:${this.relativePath}:class:${pathKey(name)}:${scopeAddress(scope.slice(1))}:L${line}`;
    const node = {
      name: nodeName,
      structure: {
        kind, displayName: name, path: this.relativePath, line, detail, properties: {}, variables: {}, bases: {},
      },
      behavior: { methods: {} },
    };
    const collection = parent.node === this.file ? parent.node.structure.classes : parent.node.structure.properties;
    const surface = parent.node === this.file ? 'structure.classes' : 'structure.properties';
    const key = uniqueKey(collection, pathKey(name), line);
    collection[key] = { node: nodeName, line };
    this.nodes.push(node);
    this.objects.set(scopeKey(scope), { node, scopePath: scope });
    this.edges.push({ frompath: `${parent.node.name}#${surface}.${key}`, topath: `${nodeName}#structure`, kind: 'contains' });
    return node;
  }

  addBase({ baseName, line = 1, classPath }) {
    const object = this.#nearestObject(this.#scopePath({ scopePath: classPath }));
    if (!object || object.node === this.file || !baseName) return;
    const key = uniqueKey(object.node.structure.bases, pathKey(baseName), line);
    object.node.structure.bases[key] = { displayName: baseName, line };
  }

  addCallable({
    name, line = 1, detail = null, scopePath, parentPath, method = false,
  }) {
    const scope = this.#scopePath({ name, scopePath, parentPath });
    const parent = CodebaseProjectionBuilder.#parentPath(scope, parentPath);
    const enclosingCallable = this.#nearestCallable(parent);
    const owner = enclosingCallable?.owner ?? this.#nearestObject(parent).node;
    const collection = enclosingCallable ? 'nested' : (method || owner !== this.file ? 'methods' : 'functions');
    const target = enclosingCallable ? (enclosingCallable.contract.nested ??= {}) : (owner.behavior[collection] ??= {});
    const key = uniqueKey(target, pathKey(name), line);
    const contract = {
      kind: collection === 'methods' ? 'method' : 'function', displayName: name, line, detail, input: {}, output: {}, calls: {},
    };
    target[key] = contract;
    const path = enclosingCallable ? `${enclosingCallable.path}.nested.${key}` : `behavior.${collection}.${key}`;
    const locator = {
      owner, path, contract, scopePath: scope,
    };
    const identity = scopeKey(scope);
    this.callables.set(identity, this.callables.has(identity) ? null : locator);
    return locator;
  }

  addVariable({ name, line = 1, parentPath }) {
    const scope = this.#scopePath({ scopePath: parentPath });
    const callable = this.#nearestCallable(scope);
    const owner = callable?.owner ?? this.#nearestObject(scope).node;
    const variableScope = callable
      ? (callable.path.includes('.nested.') ? `scope_${scopeAddress(callable.scopePath)}` : pathKey(callable.path.replace(/^behavior\./, '')))
      : 'module';
    owner.structure.variables[variableScope] ??= {};
    const key = uniqueKey(owner.structure.variables[variableScope], pathKey(name), line);
    owner.structure.variables[variableScope][key] = { displayName: name, line };
  }

  addDeclaration({ name, line = 1, kind = 'declaration' }) {
    const key = uniqueKey(this.file.structure.declarations, pathKey(name), line);
    this.file.structure.declarations[key] = { displayName: name, line, kind };
  }

  addImport({ module, line = 1 }) {
    if (!module) return;
    const key = uniqueKey(this.file.structure.imports, addressKey(module), line);
    this.file.structure.imports[key] = { module, line };
    const target = this.#external(`module:${module}`, 'external_module', 'access');
    this.edges.push({ frompath: `${this.file.name}#structure.imports.${key}`, topath: `${target.name}#behavior.access`, kind: 'imports' });
  }

  addCall({ callee, line = 1, callerPath }) {
    const callerScope = this.#scopePath({ scopePath: callerPath });
    const caller = this.callables.get(scopeKey(callerScope));
    if (!caller || !callee) return;
    const key = `call${this.callSequence++}`;
    const target = normalizeCallee(callee);
    caller.contract.calls[key] = { callee: target.qualified, line };
    this.pendingCalls.push({
      caller, callerScope, callee: target, key,
    });
  }

  finish() {
    for (const pending of this.pendingCalls) {
      const local = this.#resolveLocal(pending.callerScope, pending.callee);
      const target = local
        ? { name: local.owner.name, path: local.path }
        : { ...this.#external(`symbol:${pending.callee.qualified}`, 'external_symbol', 'invoke'), path: 'behavior.invoke' };
      this.edges.push({ frompath: `${pending.caller.owner.name}#${pending.caller.path}.calls.${pending.key}`, topath: `${target.name}#${target.path}`, kind: 'calls' });
    }
    return { nodes: [...new Map(this.nodes.map((node) => [node.name, node])).values()], edges: dedupeEdges(this.edges) };
  }

  #scopePath({ name = null, scopePath = null, parentPath = null }) {
    if (Array.isArray(scopePath) && scopePath.length > 0) return scopePath.map(segment);
    if (Array.isArray(parentPath) && name != null) return [...parentPath.map(segment), segment(name)];
    if (name != null) return [...this.fileScope, segment(name)];
    return this.fileScope;
  }

  static #parentPath(scope, parentPath) {
    return Array.isArray(parentPath) && parentPath.length > 0 ? parentPath.map(segment) : scope.slice(0, -1);
  }

  #nearestObject(scope) {
    for (let { length } = scope; length > 0; length -= 1) {
      const object = this.objects.get(scopeKey(scope.slice(0, length)));
      if (object) return object;
    }
    return this.objects.get(scopeKey(this.fileScope));
  }

  #nearestCallable(scope) {
    for (let { length } = scope; length > 0; length -= 1) {
      const callable = this.callables.get(scopeKey(scope.slice(0, length)));
      if (callable) return callable;
    }
    return null;
  }

  #resolveLocal(callerScope, callee) {
    if (!isSimpleSymbol(callee.name)) return null;
    if (callee.receiver) {
      if (callee.receiver !== 'self' && callee.receiver !== 'this') return null;
      const object = this.#nearestObject(callerScope);
      if (!object || object.node === this.file) return null;
      const identity = scopeKey([...object.scopePath, callee.name]);
      return this.callables.get(identity) ?? null;
    }
    for (let { length } = callerScope; length > 0; length -= 1) {
      const identity = scopeKey([...callerScope.slice(0, length), callee.name]);
      if (this.callables.has(identity)) return this.callables.get(identity);
    }
    return null;
  }

  #external(identity, kind, behavior) {
    const name = `external:${kind}:${addressKey(identity)}`;
    if (!this.external.has(name)) {
      const node = { name, structure: { kind, displayName: identity }, behavior: { [behavior]: {} } };
      this.external.set(name, node);
      this.nodes.push(node);
    }
    return this.external.get(name);
  }
}

function segment(value) {
  return String(value ?? '');
}

function scopeKey(scopePath) {
  return scopePath.map((value) => `s_${addressKey(value)}`).join('.');
}

function scopeAddress(scopePath) {
  return scopeKey(scopePath);
}

function isSimpleSymbol(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function normalizeCallee(callee) {
  if (typeof callee === 'string') return { name: callee, receiver: null, qualified: callee };
  const name = String(callee.name ?? '');
  const receiver = callee.receiver ? String(callee.receiver) : null;
  return {
    name,
    receiver,
    qualified: String(callee.qualified ?? (receiver ? `${receiver}.${name}` : name)),
  };
}

function uniqueKey(container, base, line) {
  if (!Object.hasOwn(container, base)) return base;
  return `${base}_L${line}`;
}

function pathKey(value) {
  const key = String(value ?? '').replace(/[^A-Za-z0-9_$:-]+/g, '_').replace(/^_+|_+$/g, '');
  return key || 'anonymous';
}

function addressKey(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

function dedupeEdges(edges) {
  const seen = new Set();
  return edges.filter((edge) => {
    const key = `${edge.frompath}|${edge.topath}|${edge.kind ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
