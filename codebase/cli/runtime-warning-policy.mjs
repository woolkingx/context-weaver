import { AuditLogger, defaultAuditLogPath } from '../../common/audit-logger.mjs';

const SQLITE_WARNING = /SQLite is an experimental feature/u;

export function installRuntimeWarningPolicy({
  auditLogger = new AuditLogger({
    logPath: defaultAuditLogPath(),
    base: { component: 'runtime' },
  }),
} = {}) {
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    auditLogger.event('runtime.warning', {
      level: 'warn',
      warning: {
        name: warning.name,
        message: warning.message,
      },
    });
    if (warning.name === 'ExperimentalWarning' && SQLITE_WARNING.test(warning.message)) return;
    process.stderr.write(`${warning.name}: ${warning.message}\n`);
  });
}

installRuntimeWarningPolicy();
