import { createHash } from 'node:crypto';
import path from 'node:path';

import { FileOwner, FileOwnerError } from '../../common/owners/files-owner.mjs';
import { LanguageParser } from '../../common/parsers/language-parser.mjs';
import { normalizeRoot } from '../../common/lib/normalize-root.mjs';
import { toolActionGraph } from '../../common/tools/tools.schema.mjs';

// Bump with the separated-module migration so blocks produced by the former
// src/ owner route cannot be reused during a stale owner rebuild.
export const CODEBASE_FILEBLOCK_PROJECTION_VERSION = 'codebase-fileblock-v17-four-owner-support-projections';

export class CodebaseFileBlockCacheGenerator {
  #root;

  #fileOwner;

  constructor({ root, fileOwner = null }) {
    if (!root) throw new TypeError('CodebaseFileBlockCacheGenerator requires root');
    this.#root = normalizeRoot(root);
    this.#fileOwner = fileOwner;
  }

  async generate({
    filePath, mtimeMs = null, content = null, contentHash = null,
  } = {}) {
    const fileOwner = await this.#getFileOwner();
    let safe;
    try {
      safe = fileOwner.assertAllowed(filePath);
    } catch (error) {
      if (error instanceof FileOwnerError || error?.code === 'OUTSIDE_CWD') {
        throw new Error(`file is outside root: ${filePath}`);
      }
      throw error;
    }
    const { absolutePath, relativePath } = safe;
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`file is outside root: ${filePath}`);
    }

    const stats = mtimeMs == null ? await fileOwner.stat(relativePath) : null;
    const resolvedMtimeMs = mtimeMs ?? stats.mtimeMs;
    const source = content ?? await fileOwner.readText(relativePath);
    const resolvedContentHash = contentHash ?? createHash('sha256').update(source).digest('hex');
    const fingerprint = CodebaseFileBlockCacheGenerator.fileFingerprint({
      filePath: relativePath,
      contentHash: resolvedContentHash,
    });
    const ext = path.extname(relativePath).slice(1).toLowerCase();
    const parsed = LanguageParser.handlesExtension(ext)
      ? await LanguageParser.parse({ content: source, absolutePath, relativePath })
      : partialFrontend(relativePath, source);
    const projection = CodebaseFileBlockCacheGenerator.assertProjection({
      result: projectSupportEvidence(parsed, relativePath, source),
      relativePath,
    });

    return {
      block: {
        file_path: relativePath,
        mtime_ms: resolvedMtimeMs,
        fingerprint,
        nodes: CodebaseFileBlockCacheGenerator.dedupeNodes({ nodes: projection.nodes }),
        edges: CodebaseFileBlockCacheGenerator.dedupeEdges({ edges: projection.edges }),
        ...(parsed.ast ? { ast: parsed.ast } : {}),
      },
      diagnostics: Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [],
    };
  }

  static fileFingerprint({ filePath, contentHash = null } = {}) {
    return createHash('sha256').update(JSON.stringify([CODEBASE_FILEBLOCK_PROJECTION_VERSION, filePath, contentHash])).digest('hex');
  }

  static dedupeNodes({ nodes = [] } = {}) {
    return [...new Map(nodes.map((node) => [node.name, node])).values()];
  }

  static dedupeEdges({ edges = [] } = {}) {
    const seen = new Set();
    return edges.filter((edge) => {
      const key = `${edge.frompath}|${edge.topath}|${edge.kind ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  static assertProjection({ result, relativePath } = {}) {
    if (!Array.isArray(result?.nodes) || !Array.isArray(result?.edges)) {
      throw new Error(`frontend did not return projection arrays: ${relativePath}`);
    }
    for (const node of result.nodes) {
      if (Object.keys(node ?? {}).sort().join(',') !== 'behavior,name,structure' || !node.name || !node.structure || !node.behavior) {
        throw new Error(`parser returned non-canonical node: ${relativePath}`);
      }
    }
    for (const edge of result.edges) {
      const keys = Object.keys(edge ?? {}).sort().join(',');
      if (!(keys === 'frompath,topath' || keys === 'frompath,kind,topath') || !edge.frompath || !edge.topath) {
        throw new Error(`parser returned non-canonical edge: ${relativePath}`);
      }
    }
    return result;
  }

  async #getFileOwner() {
    this.#fileOwner ??= await FileOwner.forRoot(this.#root);
    return this.#fileOwner;
  }
}

function partialFrontend(relativePath, source) {
  return {
    ast: {
      format: 'ctx.ast.v1',
      language: path.extname(relativePath).slice(1).toLowerCase() || 'text',
      parser_version: 'partial-text-v1',
      root: { kind: 'TextFile', path: relativePath, text: source },
    },
    nodes: [{ name: `codebase:${relativePath}`, structure: { kind: 'file', path: relativePath, frontend: 'partial' }, behavior: {} }],
    edges: [],
  };
}

function projectSupportEvidence(parsed, relativePath, source) {
  const nodes = [...parsed.nodes];
  const edges = [...parsed.edges];
  const fileName = `codebase:${relativePath}`;
  const parts = relativePath.split('/');
  let parent = 'codebase:directory:.';
  nodes.push({ name: parent, structure: { kind: 'directory', path: '.' }, behavior: {} });
  for (let index = 0; index < parts.length - 1; index += 1) {
    const directory = parts.slice(0, index + 1).join('/');
    const current = `codebase:directory:${directory}`;
    nodes.push({ name: current, structure: { kind: 'directory', path: directory }, behavior: {} });
    edges.push({ frompath: `${parent}#structure.children.${safeKey(parts[index])}`, topath: `${current}#structure` });
    parent = current;
  }
  edges.push({ frompath: `${parent}#structure.children.${safeKey(parts.at(-1))}`, topath: `${fileName}#structure` });

  if (relativePath.startsWith('docs/plan/') && relativePath.endsWith('.md')) {
    const title = source.match(/^#\s+(.+)$/m)?.[1]?.trim() || parts.at(-1);
    const summary = source.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim() || title;
    nodes.push({
      name: `codebase:plan:${relativePath}`,
      structure: {
        kind: 'plan', path: relativePath, title, summary,
      },
      behavior: {},
    });
    edges.push({ frompath: `${fileName}#behavior.plan`, topath: `codebase:plan:${relativePath}#structure`, kind: 'projects' });
  }
  // The tools catalog is a Codebase projection from the canonical nested
  // tools.schema source, never an independently admitted or persisted semantic owner.
  if (relativePath === 'common/tools/tools.schema.json') {
    const catalog = toolActionGraph();
    nodes.push(...catalog.nodes);
    edges.push(...catalog.edges);
  }
  return { ...parsed, nodes, edges };
}

function safeKey(value) {
  return String(value ?? 'entry').replace(/[^A-Za-z0-9_$:-]+/g, '_') || 'entry';
}
