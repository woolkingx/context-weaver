import { SkillImplementation } from './skill-implementation.mjs';

export class SkillService {
  constructor({ runtime, dataService }) {
    this.runtime = runtime;
    this.dataService = dataService;
  }

  async query({ root = this.runtime.cwd(), query = '', limit } = {}) {
    this.runtime.assertValidProjectRoot(root);
    this.runtime.startCommand({
      root, module: 'skill', operation: 'query', query,
    });
    return this.#withImplementation(root, (implementation) => implementation.query({ root, query, limit }));
  }

  async load({ root = this.runtime.cwd(), name, into } = {}) {
    if (!name) throw new TypeError('skill.load requires name.');
    this.runtime.assertValidProjectRoot(root);
    this.runtime.startCommand({
      root, module: 'skill', operation: 'load', name,
    });
    return this.#withImplementation(root, (implementation) => implementation.load({ root, name, into }));
  }

  async list({ root = this.runtime.cwd() } = {}) {
    this.runtime.assertValidProjectRoot(root);
    this.runtime.startCommand({ root, module: 'skill', operation: 'list' });
    return this.#withImplementation(root, (implementation) => implementation.list({ root }));
  }

  #withImplementation(root, callback) {
    return this.dataService.withProjectionSession(root, ['skills'], (session) => callback(new SkillImplementation({
      projectionSession: session,
    })));
  }
}
