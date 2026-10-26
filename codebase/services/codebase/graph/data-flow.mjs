import { GraphResolver } from './graph-resolve.mjs';

export class DataFlow {
  constructor({ resolved }) {
    this.resolved = resolved;
  }

  project() {
    const { resolved } = this;
    const messages = [GraphResolver.createMessage(0, 'self', resolved.displayName, resolved.kind, resolved.file, resolved.line)];
    const m = resolved.method ?? {};

    for (const [, param] of Object.entries(m.input ?? {})) {
      messages.push(GraphResolver.createMessage(1, 'source', param.displayName, 'param', resolved.file, m.line));
    }
    for (const [, call] of Object.entries(m.calls ?? {})) {
      const args = (call.args ?? []).map((a) => a.expression).filter(Boolean);
      if (args.length > 0) {
        messages.push(GraphResolver.createMessage(1, 'transform', call.callee, 'call', resolved.file, call.line, { args }));
      }
    }
    const ret = m.output?.return;
    if (ret) {
      messages.push(GraphResolver.createMessage(1, 'sink', ret.expression ?? 'return', 'return', resolved.file, ret.line));
    }

    return GraphResolver.createResult('data', resolved.displayName, messages);
  }
}
