// ─── CLI Argv Projection ──────────────────────────────────────────────────────
//
// The per-method argv keywords (flag, aliases, position, rest) and the usage text
// are properties of the method node in tools.schema.json; nothing is repeated here.
// This file holds only the flags every command shares and reads from that node.

import { TOOLS_SCHEMA } from '../../common/tools/tools.schema.mjs';

export const GLOBAL_FLAGS = Object.freeze({
  quiet: { flag: '--quiet', aliases: ['-q'], type: 'boolean' },
  json: { flag: '--json', type: 'boolean' },
  root: { flag: '--root', type: 'string' },
});

export function argvOf(methodNode) {
  return Object.fromEntries(Object.entries(methodNode?.properties ?? {})
    .filter(([, property]) => property.flag || Number.isInteger(property.position) || property.rest));
}

export function getUsage(target, method) {
  return TOOLS_SCHEMA[target]?.[method]?.usage ?? 'ctx help';
}
