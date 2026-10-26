import { DEFAULT_CACHE_OWNERS } from '../../../common/tools/tools.schema.mjs';

export class SqlService {
  constructor({ runtime }) {
    this.runtime = runtime;
  }

  async run({ root = this.runtime.cwd(), query, owners }) {
    if (!query) throw new TypeError('sql.run requires query.');
    const resolved = owners ?? [...DEFAULT_CACHE_OWNERS];
    this.runtime.assertValidProjectRoot(root);
    this.runtime.startCommand({ root, owners: resolved });
    let session = null;
    try {
      session = await this.runtime.openProjectionSession(root, { owners: resolved });
      this.runtime.auditEvent('ctx.sql.start', { sql: query });
      const rows = session.sql({ sql: query });
      this.runtime.auditEvent('ctx.sql.end', { sql: query, row_count: rows.length });
      return {
        object: 'SqlResult', module: 'sql', status: 'ok', rowCount: rows.length, rows,
      };
    } finally {
      session?.close();
    }
  }
}
