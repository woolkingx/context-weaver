/**
 * RuleService - 提供 rule module 的 API
 */

export class RuleService {
  constructor({ runtime, dataService }) {
    this.runtime = runtime;
    this.dataService = dataService;
  }

  async queryRules({ root }) {
    this.runtime.assertValidProjectRoot(root);
    return this.dataService.withProjectionSession(root, ['rules'], (session) => {
      const rows = session.query({
        sql: `SELECT name,
                     json_extract(structure, '$.path') AS path,
                     json_extract(structure, '$.root_id') AS root_id
              FROM nodes
              WHERE json_extract(structure, '$.kind') = 'rule'
              ORDER BY name`,
      });
      return {
        object: 'RuleResult',
        module: 'rule',
        source: 'rules',
        status: 'ok',
        count: rows.length,
        rules: rows.map((row) => ({
          name: row.name,
          path: row.path ?? null,
          root_id: row.root_id ?? null,
        })),
        cache: session.cacheReceipt(),
      };
    });
  }

  async run({ root = this.runtime.cwd() } = {}) {
    return this.queryRules({ root });
  }
}
