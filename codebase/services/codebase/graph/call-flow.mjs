import { GraphResolver } from './graph-resolve.mjs';

export class CallFlow {
  constructor({ session, resolved }) {
    this.session = session;
    this.resolved = resolved;
  }

  project({ direction } = {}) {
    const { resolved } = this;
    const messages = [GraphResolver.createMessage(0, 'self', resolved.displayName, resolved.kind, resolved.file, resolved.line)];

    if (direction === 'out' || direction === 'both') this.#projectCallees(messages);
    if (direction === 'in' || direction === 'both') this.#projectCallers(messages);

    return GraphResolver.createResult('call', resolved.displayName, messages);
  }

  #projectCallees(messages) {
    const calls = this.#collectOutboundCalls();
    for (const [, call] of Object.entries(calls)) {
      messages.push(GraphResolver.createMessage(1, 'callee', call.callee, 'call', this.resolved.file, call.line));
    }
  }

  #projectCallers(messages) {
    const symbolName = this.resolved.displayName?.split('.').pop() ?? this.resolved.displayName;
    const pattern = new RegExp(`(^|\\.)${GraphResolver.escapeRegex(symbolName)}$`);

    const rows = this.session.query({
      sql: `SELECT name, node_kind, structure, behavior FROM node_rows
            WHERE node_kind IN ('class', 'file')`,
    });
    for (const row of rows) {
      const s = GraphResolver.parseJson(row.structure);
      const b = GraphResolver.parseJson(row.behavior);
      const owner = s.displayName ?? s.path;

      for (const [, method] of Object.entries(b.methods ?? {})) {
        for (const [, call] of Object.entries(method.calls ?? {})) {
          if (pattern.test(call.callee)) {
            messages.push(GraphResolver.createMessage(1, 'caller', `${owner}.${method.displayName}`, 'method', s.path, call.line, { via: call.callee }));
          }
        }
      }
      for (const [, fn] of Object.entries(b.functions ?? {})) {
        for (const [, call] of Object.entries(fn.calls ?? {})) {
          if (pattern.test(call.callee)) {
            messages.push(GraphResolver.createMessage(1, 'caller', fn.displayName, 'function', s.path, call.line, { via: call.callee }));
          }
        }
      }
    }
  }

  #collectOutboundCalls() {
    const { resolved } = this;
    if (resolved.method?.calls) return resolved.method.calls;
    const all = {};
    for (const [, method] of Object.entries(resolved.behavior?.methods ?? {})) {
      for (const [k, call] of Object.entries(method.calls ?? {})) {
        all[`${method.displayName}.${k}`] = call;
      }
    }
    return all;
  }
}
