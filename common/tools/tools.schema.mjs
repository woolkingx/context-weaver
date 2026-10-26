import { ErrorObject } from '../lib/error-object.mjs';
import { Loader, ObjectTree } from '../schema2object.mjs';
import schema from './tools.schema.json' with { type: 'json' };

// ─── Public API schema entry ──────────────────────────────────────────────────
//
// tools.schema.json (JSON Schema Draft-07) is the public API schema:
// properties.<target>.properties.<method> is the value structure of that
// method's payload, with its defaults, constraints and argv keywords.
// This module only loads it (one root Loader, as the schema2object project entry)
// and exposes `payloads['<target>.<method>'](input)`, which validates the
// input and supplies the schema defaults through ObjectTree.from.

const rootLoader = new Loader(schema);

// target -> method -> method node (the payload schema with description, help, usage, output).
export const TOOLS_SCHEMA = Object.freeze(Object.fromEntries(
  Object.entries(schema.properties).map(([target, node]) => [target, Object.freeze(node.properties)]),
));

export const payloads = Object.freeze(Object.fromEntries(
  Object.entries(TOOLS_SCHEMA).flatMap(([target, methods]) => Object.keys(methods).map((method) => {
    const { node, loader } = rootLoader.resolve(`#/properties/${target}/properties/${method}`);
    return [`${target}.${method}`, (input) => ObjectTree.from(input, node, loader)];
  })),
));

const ownerIds = Object.freeze(['rules', 'skills', 'handbook', 'codebase']);

// ─── Owner & Module Constants ─────────────────────────────────────────────────

export const RUNTIME_OWNERS = Object.freeze(ownerIds);
export const CACHE_OWNERS = Object.freeze(ownerIds);
export const DEFAULT_CACHE_OWNERS = CACHE_OWNERS;
export const CLI_MODULES = Object.freeze(['rule', 'skill', 'handbook', 'codebase']);
export const CLI_MODULE_SET = new Set(CLI_MODULES);

// ─── Schema Errors ────────────────────────────────────────────────────────────

export class ToolSchemaError extends ErrorObject {
  constructor(message, code = 'TOOL_SCHEMA_ERROR', metadata = {}) {
    super({
      code, message, cause: metadata.cause ?? null, context: metadata,
    });
    this.name = 'ToolSchemaError';
    this.metadata = metadata;
  }
}

// ─── Schema Accessors ─────────────────────────────────────────────────────────

export function getMethodSpec(target, methodName) {
  return TOOLS_SCHEMA[target]?.[methodName] ?? null;
}

export function getServiceModule(target) {
  if (target === 'help') return 'codebase/cli/help-text.mjs';
  if (target === 'sql' || target === 'cache') return `codebase/data-service/control/${target}-service.mjs`;
  if (CLI_MODULE_SET.has(target)) return `codebase/services/${target}/${target}-service.mjs`;
  return null;
}

// ─── Owner Validation ─────────────────────────────────────────────────────────

export function validateOwners(owners, { scope = 'runtime' } = {}) {
  const valid = new Set(scope === 'cache' ? CACHE_OWNERS : RUNTIME_OWNERS);
  const invalid = owners.filter((owner) => !valid.has(owner));
  if (invalid.length) throw new ToolSchemaError(`Unknown ${scope} owner(s): ${invalid.join(', ')}`, 'INVALID_OWNER', { invalid, scope });
  return owners;
}

// ─── Graph Projection ─────────────────────────────────────────────────────────

export function toolActionGraph() {
  const nodes = [];
  const edges = [];
  for (const [target, methods] of Object.entries(TOOLS_SCHEMA)) {
    const targetNode = `ctx.tool.target.${target}`;
    nodes.push({ name: targetNode, structure: { kind: 'target', content: target }, behavior: {} });
    for (const [methodName, spec] of Object.entries(methods)) {
      const methodNode = `ctx.tool.method.${target}.${methodName}`;
      nodes.push({
        name: methodNode,
        structure: {
          kind: 'method',
          doc: spec.description,
          input: Object.fromEntries(Object.entries(spec.properties).map(([name, property]) => [name, property.type])),
          output: spec.output,
        },
        behavior: {},
      });
      edges.push({ frompath: `${targetNode}#behavior.methods`, topath: `${methodNode}#structure` });
    }
  }
  return { nodes, edges };
}
