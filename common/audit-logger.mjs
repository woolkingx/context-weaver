import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigOwner } from './config/ConfigOwner.mjs';

export function defaultAuditLogPath(now = new Date(), paths = new ConfigOwner().resolve().paths) {
  const day = now.toISOString().slice(0, 10);
  return path.join(paths.auditDir, `ctx-ops-${day}.jsonl`);
}

export function errorFields(error) {
  if (!error) return null;
  const context = visibleErrorContext(error);
  return {
    name: error.name ?? 'Error',
    code: error.code ?? null,
    message: String(error.message ?? error),
    ...(error.recovery_hint ? { recovery_hint: error.recovery_hint } : {}),
    ...(context ? { context } : {}),
    ...(error.cause ? { cause: String(error.cause.message ?? error.cause) } : {}),
  };
}

function visibleErrorContext(error) {
  if (!error.context || typeof error.context !== 'object') return null;
  const context = Object.fromEntries(Object.entries(error.context)
    .filter(([key]) => key !== 'stack' && key !== 'cause'));
  return Object.keys(context).length > 0 ? context : null;
}

export class AuditLogger {
  constructor({ logPath = defaultAuditLogPath(), traceId = randomUUID(), base = {} } = {}) {
    this.logPath = logPath;
    this.traceId = traceId;
    this.base = { pid: process.pid, ...base };
  }

  child(base) {
    return new AuditLogger({
      logPath: this.logPath,
      traceId: this.traceId,
      base: { ...this.base, ...base },
    });
  }

  event(event, fields = {}) {
    const row = {
      ts: new Date().toISOString(),
      trace_id: this.traceId,
      level: fields.level ?? 'info',
      event,
      ...this.base,
      ...sanitize(fields),
    };
    delete row.level_override;
    try {
      mkdirSync(path.dirname(this.logPath), { recursive: true });
      appendFileSync(this.logPath, `${JSON.stringify(row)}\n`, 'utf8');
    } catch {
      // Audit must never change ctx command behavior.
    }
  }
}

function sanitize(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (key === 'sql' && typeof item === 'string') {
      out.query_preview = item.slice(0, 240);
      out.query_length = item.length;
      continue;
    }
    out[key] = sanitize(item);
  }
  return out;
}
