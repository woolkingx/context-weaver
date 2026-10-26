import { GraphResolver } from './graph-resolve.mjs';

export class SeqFlow {
  constructor({ session, src, tgt }) {
    this.session = session;
    this.src = src;
    this.tgt = tgt;
  }

  project() {
    const { src, tgt } = this;
    const messages = [GraphResolver.createMessage(0, 'start', src.displayName, src.kind, src.file, src.line)];
    const steps = this.#trace(src.method?.calls ?? {}, src.displayName, src.file, 1);

    messages.push(...steps);

    if (!steps.some((s) => s.direction === 'end')) {
      messages.push(GraphResolver.createMessage(1, 'unresolved', tgt.displayName, tgt.kind, tgt.file, tgt.line));
    }

    return GraphResolver.createResult('seq', `${src.displayName} → ${tgt.displayName}`, messages);
  }

  #trace(calls, ownerName, ownerFile, depth) {
    if (depth > 6) return [];
    const tgtName = this.tgt.displayName?.split('.').pop();
    const visited = new Set();
    const steps = [];

    for (const [, call] of Object.entries(calls)) {
      const key = `${ownerFile}:${call.callee}:${call.line}`;
      if (visited.has(key)) continue;
      visited.add(key);

      steps.push(GraphResolver.createMessage(depth, 'step', call.callee, 'call', ownerFile, call.line, { from: ownerName }));

      if (call.callee.includes(tgtName)) {
        steps.push(GraphResolver.createMessage(depth + 1, 'end', this.tgt.displayName, this.tgt.kind, this.tgt.file, this.tgt.line));
        return steps;
      }
    }
    return steps;
  }
}
