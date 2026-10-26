import { GraphResolver } from './graph-resolve.mjs';
import { ContainFlow } from './contain-flow.mjs';
import { CallFlow } from './call-flow.mjs';
import { DepFlow } from './dep-flow.mjs';
import { DataFlow } from './data-flow.mjs';
import { SeqFlow } from './seq-flow.mjs';

// The five graph views of a symbol or file over node_rows and edge_rows. They
// belong to the Codebase module: CodebaseService composes this object, and it is
// not a service of its own.
export class GraphViews {
  constructor({ runtime, dataService }) {
    this.runtime = runtime;
    this.dataService = dataService;
  }

  async contain({ root = this.runtime.cwd(), symbol, depth }) {
    return this.#dispatch('contain', root, symbol, (session, resolved) => new ContainFlow({ session, resolved }).project({ depth }));
  }

  async call({
    root = this.runtime.cwd(), symbol, direction,
  }) {
    return this.#dispatch('call', root, symbol, (session, resolved) => new CallFlow({ session, resolved }).project({ direction }));
  }

  async dep({
    root = this.runtime.cwd(), symbol, direction,
  }) {
    return this.#dispatch('dep', root, symbol, (session, resolved) => new DepFlow({ session, resolved }).project({ direction }));
  }

  async data({ root = this.runtime.cwd(), symbol }) {
    return this.#dispatch('data', root, symbol, (session, resolved) => new DataFlow({ resolved }).project());
  }

  async seq({ root = this.runtime.cwd(), from, to }) {
    return this.#withSession(root, (session) => {
      const src = GraphResolver.resolveSymbol(session, from);
      const tgt = GraphResolver.resolveSymbol(session, to);
      if (!src || !tgt) return GraphResolver.createResult('seq', `${from} → ${to}`, [], `Symbol not found: ${!src ? from : to}`);
      return new SeqFlow({ session, src, tgt }).project();
    });
  }

  #dispatch(flow, root, symbol, callback) {
    return this.#withSession(root, (session) => {
      const resolved = GraphResolver.resolveSymbol(session, symbol);
      if (!resolved) return GraphResolver.createResult(flow, symbol, [], `Symbol not found: ${symbol}`);
      return callback(session, resolved);
    });
  }

  #withSession(root, callback) {
    this.runtime.assertValidProjectRoot(root);
    this.runtime.startCommand({ root, module: 'codebase' });
    return this.dataService.withProjectionSession(root, ['codebase'], (session) => callback(session));
  }
}
