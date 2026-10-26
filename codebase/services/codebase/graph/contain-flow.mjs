import { GraphResolver } from './graph-resolve.mjs';

export class ContainFlow {
  constructor({ session, resolved }) {
    this.session = session;
    this.resolved = resolved;
  }

  project({ depth } = {}) {
    const { resolved } = this;
    const messages = [GraphResolver.createMessage(0, 'self', resolved.displayName, resolved.kind, resolved.file, resolved.line)];

    if (resolved.kind === 'file') this.#projectFile(messages, depth);
    else if (resolved.kind === 'class') this.#projectMembers(messages, 1, depth);
    else if (resolved.kind === 'method' || resolved.kind === 'function') this.#projectMethod(messages);

    return GraphResolver.createResult('contain', resolved.displayName, messages);
  }

  #projectFile(messages, maxDepth) {
    const { resolved, session } = this;
    const s = resolved.structure;
    const b = resolved.behavior;

    for (const [, imp] of Object.entries(s.imports ?? {})) {
      messages.push(GraphResolver.createMessage(1, 'import', imp.module, 'import', resolved.file, imp.line, {
        bindings: Object.keys(imp.bindings ?? {}),
      }));
    }
    for (const [, exp] of Object.entries(s.exports ?? {})) {
      messages.push(GraphResolver.createMessage(1, 'export', exp.displayName, 'export', resolved.file, exp.line));
    }
    for (const [, cls] of Object.entries(s.classes ?? {})) {
      const classNode = GraphResolver.resolveNodeByName(session, cls.node);
      if (classNode) {
        messages.push(GraphResolver.createMessage(1, 'child', classNode.displayName, 'class', resolved.file, cls.line));
        if (maxDepth >= 2) ContainFlow.#appendClassMembers(messages, classNode, 2, maxDepth);
      }
    }
    for (const [, fn] of Object.entries(b.functions ?? {})) {
      messages.push(GraphResolver.createMessage(1, 'child', fn.displayName, 'function', resolved.file, fn.line));
    }
  }

  #projectMembers(messages, baseDepth, maxDepth) {
    ContainFlow.#appendClassMembers(messages, this.resolved, baseDepth, maxDepth);
  }

  #projectMethod(messages) {
    const m = this.resolved.method;
    for (const [, param] of Object.entries(m.input ?? {})) {
      messages.push(GraphResolver.createMessage(1, 'input', param.displayName, 'param', this.resolved.file, m.line));
    }
    for (const [, call] of Object.entries(m.calls ?? {})) {
      messages.push(GraphResolver.createMessage(1, 'calls', call.callee, 'call', this.resolved.file, call.line));
    }
  }

  static #appendClassMembers(messages, node, baseDepth, maxDepth) {
    const b = node.behavior ?? {};
    for (const [, method] of Object.entries(b.methods ?? {})) {
      messages.push(GraphResolver.createMessage(baseDepth, 'child', method.displayName, 'method', node.file, method.line));
      if (maxDepth > baseDepth) {
        for (const [, call] of Object.entries(method.calls ?? {})) {
          messages.push(GraphResolver.createMessage(baseDepth + 1, 'calls', call.callee, 'call', node.file, call.line));
        }
      }
    }
  }
}
