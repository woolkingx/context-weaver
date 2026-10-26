import { TOOLS_SCHEMA } from '../../common/tools/tools.schema.mjs';

export class HelpCommand {
  constructor({ catalog = TOOLS_SCHEMA } = {}) {
    this.catalog = catalog;
  }

  render({ full = false } = {}) {
    const lines = [
      'Context Weaver — project graph compiler',
      '',
      'The graph is the API. Use sql to query node_rows / edge_rows.',
      '',
    ];
    for (const [target, methods] of Object.entries(this.catalog)) {
      const entries = Object.entries(methods);
      for (const [method, spec] of entries) {
        if (spec.disabled && !full) continue;
        const usage = spec.usage ?? `ctx ${target} ${method}`;
        const doc = spec.disabled ? `${spec.description} [disabled]` : spec.description;
        lines.push(`  ${usage.padEnd(44)} ${doc}`);
      }
    }
    if (full) {
      lines.push('', 'SQL examples (the primary query interface):', '');
      lines.push('  # Find files');
      lines.push("  ctx sql \"SELECT file_path FROM node_rows WHERE name LIKE '%auth%'\"");
      lines.push('');
      lines.push('  # Search symbols');
      lines.push("  ctx sql \"SELECT name, file_path, node_kind FROM node_rows WHERE node_kind='function' AND name LIKE '%Service%'\"");
      lines.push('');
      lines.push('  # Find call edges');
      lines.push('  ctx sql "SELECT s.name AS caller, t.name AS callee FROM edge_rows e');
      lines.push('    JOIN node_rows s ON e.source_node_key=s.node_key');
      lines.push('    JOIN node_rows t ON e.target_node_key=t.node_key');
      lines.push("    WHERE e.edge_kind='calls'\"");
      lines.push('');
      lines.push('  # Codebase stats');
      lines.push('  ctx sql "SELECT node_kind, count(*) AS n FROM node_rows GROUP BY node_kind ORDER BY n DESC"');
      lines.push('');
      lines.push('Payload details:');
      for (const [target, methods] of Object.entries(this.catalog)) {
        for (const [method, spec] of Object.entries(methods)) {
          const fields = Object.keys(spec.properties ?? {});
          const req = spec.required ?? [];
          const fieldStr = fields.map((f) => (req.includes(f) ? `${f}*` : f)).join(', ') || '(none)';
          lines.push(`  ${target}.${method}(${fieldStr}) → ${spec.output ?? 'string'}`);
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

export const HelpService = HelpCommand;
