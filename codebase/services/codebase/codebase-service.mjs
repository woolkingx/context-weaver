import { CodebaseImplementation } from './codebase-implementation.mjs';
import { GraphViews } from './graph/graph-views.mjs';
import { CodebaseSearch } from './search.mjs';

export class CodebaseService {
  #graph;

  constructor({ runtime, dataService }) {
    this.runtime = runtime;
    this.dataService = dataService;
    this.#graph = new GraphViews({ runtime, dataService });
  }

  async relate(payload = {}) {
    return this.#withImplementation(payload.root, (impl) => impl.relate(payload));
  }

  async token(payload = {}) {
    return this.#withImplementation(payload.root, (impl) => impl.token(payload));
  }

  async search(payload = {}) {
    const root = payload.root ?? this.runtime.cwd();
    this.#begin(root);
    return this.dataService.withProjectionSession(root, ['codebase'], (session) => new CodebaseSearch({ session })
      .run(payload));
  }

  async slice(payload = {}) {
    return this.#withImplementation(payload.root, (impl) => impl.slice(payload));
  }

  async contain(payload) {
    return this.#graph.contain(payload);
  }

  async call(payload) {
    return this.#graph.call(payload);
  }

  async dep(payload) {
    return this.#graph.dep(payload);
  }

  async data(payload) {
    return this.#graph.data(payload);
  }

  async seq(payload) {
    return this.#graph.seq(payload);
  }

  #withImplementation(root = this.runtime.cwd(), callback) {
    this.#begin(root);
    return this.dataService.withProjectionSession(root, ['codebase'], (session, config) => callback(new CodebaseImplementation({
      config,
      projectionSession: session,
    })));
  }

  #begin(root) {
    this.runtime.assertValidProjectRoot(root);
    this.runtime.startCommand({ root, module: 'codebase' });
  }
}
