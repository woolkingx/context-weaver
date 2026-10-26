// Read-only SQL boundary shared by ContextDb and the CLI command.
import { constants } from 'node:sqlite';

const ALLOWED_LEADING = /^\s*(select|with|pragma)\b/i;
const PRAGMA_ALLOWED = /^\s*pragma\s+(table_info|table_list|index_list|foreign_key_list)\s*\(/i;
const STACKED = /;\s*\S/;
const DENIED_ACTIONS = new Set([
  constants.SQLITE_INSERT,
  constants.SQLITE_UPDATE,
  constants.SQLITE_DELETE,
  constants.SQLITE_CREATE_TABLE,
  constants.SQLITE_CREATE_TEMP_TABLE,
  constants.SQLITE_CREATE_INDEX,
  constants.SQLITE_CREATE_TRIGGER,
  constants.SQLITE_CREATE_VIEW,
  constants.SQLITE_DROP_TABLE,
  constants.SQLITE_DROP_INDEX,
  constants.SQLITE_DROP_TRIGGER,
  constants.SQLITE_DROP_VIEW,
  constants.SQLITE_ALTER_TABLE,
  constants.SQLITE_ATTACH,
  constants.SQLITE_DETACH,
  constants.SQLITE_TRANSACTION,
]);

export class SqlNotAllowedError extends Error {
  constructor(reason) {
    super(`SQL rejected: ${reason}`);
    this.name = 'SqlNotAllowedError';
    this.code = 'SQL_NOT_ALLOWED';
  }
}

export function assertReadOnlyStatement(sql) {
  const text = String(sql ?? '');
  if (!text.trim()) throw new SqlNotAllowedError('empty statement');
  if (STACKED.test(text.trim().replace(/;\s*$/, ''))) {
    throw new SqlNotAllowedError('stacked statements are not allowed');
  }
  if (!ALLOWED_LEADING.test(text)) {
    throw new SqlNotAllowedError('only SELECT / WITH / PRAGMA queries are allowed');
  }
  if (/^\s*pragma\b/i.test(text) && !PRAGMA_ALLOWED.test(text)) {
    throw new SqlNotAllowedError('only introspection PRAGMAs are allowed');
  }
  return text;
}

export function installReadOnlyAuthorizer(db, { blockedTables = [] } = {}) {
  const blocked = new Set(blockedTables);
  db.setAuthorizer((action, table, column, database, viewName) => {
    if (DENIED_ACTIONS.has(action)) return constants.SQLITE_DENY;
    if (action === constants.SQLITE_READ && database === 'main' && blocked.has(table) && !viewName) return constants.SQLITE_DENY;
    return constants.SQLITE_OK;
  });
}
