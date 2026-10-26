import path from 'node:path';
import { createHash } from 'node:crypto';

import { LanguageParser } from '../../../common/parsers/language-parser.mjs';
import { CodebaseFileBlockCacheGenerator } from '../codebase-file-block-cache-generator.mjs';
import { OwnerCacheCoordinator } from '../persistent-owner-runner.mjs';
import { FileOwner } from '../../../common/owners/files-owner.mjs';
import { ownerManifest } from '../../../common/lib/source-fingerprint.mjs';
import { normalizeRoot } from '../../../common/lib/normalize-root.mjs';

const CODEBASE_ADMISSION_CONCURRENCY = 8;
const LOCAL_MODULE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];

export const CODEBASE_OWNER_DEFINITION = {
  name: 'codebase',
  // The separated-module topology changes owner identity and import closure;
  // bump the manifest generation so persistent blocks from the pre-refactor
  // src/ route cannot be replayed as current codebase truth.
  producerGeneration: 'codebase-v9-source-revision-capability',
  admit: (root) => CodebaseAdmission.admit(root),
  build: (payload) => CodebaseFileBlockBuilder.build(payload),
};

// 1. Codebase Admission Domain Class
export class CodebaseAdmission {
  // Codebase owns executable source and the repository-local support evidence
  // (schemas, plans, and configuration). Non-code text still receives a
  // complete, explicitly partial frontend value; it never becomes a support
  // owner FileBlock.
  static admitsFile(extension, relativePath) {
    if (LanguageParser.handlesExtension(extension) || extension === 'json') return true;
    // Plans are Codebase support evidence, but broad text admission would make
    // cache behavior depend on unrelated archives and research material.
    return extension === 'md' && String(relativePath).startsWith('docs/plan/');
  }

  static async admit(root) {
    const rootPath = normalizeRoot(root);
    const fileOwner = await FileOwner.forRoot(rootPath);
    const fileSet = await fileOwner.listAdmittedFiles({
      maxFiles: Infinity,
      acceptExtension: (ext, rel) => this.admitsFile(ext, rel),
      withMtime: true,
      withSize: true,
    });
    const contentFingerprints = [];
    const contentByPath = new Map();
    const admittedContent = await this.#mapConcurrent(fileSet.files, async (file) => {
      const content = await fileOwner.readText(file.path);
      const contentHash = createHash('sha256').update(content).digest('hex');
      return { file, content, contentHash };
    }, CODEBASE_ADMISSION_CONCURRENCY);
    for (const { file, content, contentHash } of admittedContent) {
      contentByPath.set(file.path, { content, contentHash, metadataHit: false });
      contentFingerprints.push({ path: file.path, sha256: contentHash });
    }
    return {
      root: rootPath,
      fileOwner,
      fileSet,
      contentByPath,
      manifest: await ownerManifest({
        fileSet: { ...fileSet, files: fileSet.files.map((file) => ({ ...file, root_id: rootPath, sha256: contentByPath.get(file.path).contentHash })) },
        policyInputs: await fileOwner.inputMetadataForFingerprint(),
        extraInputs: [{ contentFingerprints }],
        producerGeneration: CODEBASE_OWNER_DEFINITION.producerGeneration,
      }),
    };
  }

  static async #mapConcurrent(items, mapper, concurrency) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    };
    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
  }
}

// 2. Cross-File Reference Projector Domain Class
export class CodebaseReferenceProjector {
  static projectLocalReferences(blocks, admittedPaths) {
    const projectedBlocks = blocks.map((block) => ({
      ...block,
      nodes: [...block.nodes],
      edges: [...block.edges],
    }));
    const normalizedPaths = new Set(admittedPaths.map(this.#normalizeRelativePath));
    const nodes = projectedBlocks.flatMap((block) => block.nodes);
    const nodeByName = new Map(nodes.map((node) => [node.name, node]));
    const fileByPath = new Map(
      nodes
        .filter((node) => node.structure?.kind === 'file' && node.structure.path)
        .map((node) => [this.#normalizeRelativePath(node.structure.path), node]),
    );
    for (const block of projectedBlocks) {
      block.edges = block.edges.map((edge) => {
        const match = /^(.*)#structure\.imports\.([^.]+)$/.exec(edge.frompath);
        if (!match) return edge;
        const source = nodeByName.get(match[1]);
        const imported = source?.structure?.imports?.[match[2]]?.module;
        const targetPath = this.#resolveLocalModule(source?.structure?.path, imported, normalizedPaths);
        const targetName = targetPath ? `codebase:${targetPath}` : null;
        if (!targetName || !nodeByName.has(targetName) || edge.topath === `${targetName}#structure`) return edge;
        return { ...edge, topath: `${targetName}#structure` };
      });
    }

    // Parsers resolve calls within one file. This second projection resolves
    // the remaining imported bindings after all FileBlocks are available, so
    // it can remain a pure graph projection rather than leaking repository
    // knowledge into each language parser.
    for (const block of projectedBlocks) {
      block.edges = block.edges.map((edge) => {
        if (edge.kind !== 'calls') return edge;
        const sourceName = this.#nodeName(edge.frompath);
        const caller = nodeByName.get(sourceName);
        const sourceFile = fileByPath.get(this.#normalizeRelativePath(caller?.structure?.path));
        const call = this.#readNodePath(caller, edge.frompath.slice(sourceName.length + 1));
        const existingTarget = nodeByName.get(this.#nodeName(edge.topath));
        if (existingTarget?.structure?.path && existingTarget.structure.path === sourceFile?.structure?.path) return edge;
        const target = this.#resolveImportedCall(call?.callee, sourceFile, fileByPath, normalizedPaths, nodeByName);
        if (target) {
          const topath = `${target.node}#${target.path}`;
          return edge.topath === topath ? edge : { ...edge, topath };
        }
        if (!this.#isImportedCall(call?.callee, sourceFile, normalizedPaths)) return edge;
        const external = this.#ensureExternalCall(block, call.callee, nodeByName);
        const topath = `${external.name}#behavior.invoke`;
        return edge.topath === topath ? edge : { ...edge, topath };
      });
    }

    for (const block of projectedBlocks) {
      if (!block.value?.ast) continue;
      block.value = {
        ...block.value,
        ast: {
          ...block.value.ast,
          nodes: block.nodes,
          edges: block.edges,
        },
      };
    }

    const referencedNames = new Set(projectedBlocks.flatMap((block) => block.edges.flatMap((edge) => [this.#nodeName(edge.frompath), this.#nodeName(edge.topath)])));
    const removableKinds = new Set(['external_module', 'external_symbol']);
    for (const block of projectedBlocks) {
      const retained = block.nodes.filter((node) => !removableKinds.has(node.structure?.kind) || referencedNames.has(node.name));
      if (retained.length !== block.nodes.length) {
        block.nodes = retained;
      }
    }

    return { blocks: projectedBlocks };
  }

  static #resolveImportedCall(callee, sourceFile, fileByPath, admittedPaths, nodeByName) {
    if (!sourceFile || typeof callee !== 'string') return null;
    const segments = callee.split('.');
    if (segments.length < 1 || segments.length > 2 || segments.some((segment) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment))) return null;
    if (segments[0] === 'this' || segments[0] === 'self') return null;

    for (const entry of Object.values(sourceFile.structure?.imports ?? {})) {
      const binding = entry.bindings?.[segments[0]];
      if (!binding) continue;
      const targetPath = this.#resolveLocalModule(sourceFile.structure.path, entry.module, admittedPaths);
      const targetFile = fileByPath.get(targetPath);
      if (!targetFile) continue;

      const exportName = segments.length === 1
        ? (binding === '*' ? null : binding)
        : (binding === '*' ? segments[1] : binding);
      if (!exportName) continue;
      const exported = this.#findExport(targetFile, exportName, fileByPath, admittedPaths);
      if (!exported) continue;
      if (segments.length === 1) return exported;
      const member = this.#findMember(nodeByName.get(exported.node), segments[1]);
      if (member) return { node: exported.node, path: member };
    }
    return null;
  }

  static #isImportedCall(callee, sourceFile, admittedPaths) {
    if (!sourceFile || typeof callee !== 'string') return false;
    const segments = callee.split('.');
    if (segments.length < 1 || segments.length > 2 || segments.some((segment) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment))) return false;
    if (segments[0] === 'this' || segments[0] === 'self') return false;
    return Object.values(sourceFile.structure?.imports ?? {}).some((entry) => {
      if (!entry.bindings?.[segments[0]]) return false;
      return !!this.#resolveLocalModule(sourceFile.structure.path, entry.module, admittedPaths);
    });
  }

  static #ensureExternalCall(block, callee, nodeByName) {
    const name = `external:external_symbol:${Buffer.from(`symbol:${callee}`, 'utf8').toString('base64url')}`;
    let node = nodeByName.get(name);
    if (!node) {
      node = { name, structure: { kind: 'external_symbol', displayName: `symbol:${callee}` }, behavior: { invoke: {} } };
      nodeByName.set(name, node);
      block.nodes.push(node);
    }
    return node;
  }

  static #findExport(fileNode, displayName, fileByPath = null, admittedPaths = null, seen = new Set()) {
    const direct = Object.values(fileNode?.structure?.exports ?? {}).find((entry) => entry.displayName === displayName);
    if (direct || !fileByPath || !admittedPaths) return direct ?? null;
    const filePath = this.#normalizeRelativePath(fileNode?.structure?.path);
    if (seen.has(filePath)) return null;
    seen.add(filePath);
    for (const entry of Object.values(fileNode?.structure?.reexports ?? {})) {
      if (entry.imported !== '*' && entry.displayName !== displayName) continue;
      const targetPath = this.#resolveLocalModule(filePath, entry.module, admittedPaths);
      const targetFile = fileByPath.get(targetPath);
      const resolved = this.#findExport(targetFile, entry.imported === '*' ? displayName : entry.imported, fileByPath, admittedPaths, seen);
      if (resolved) return resolved;
    }
    return null;
  }

  static #findMember(node, displayName) {
    for (const [collectionName, collection] of Object.entries({
      methods: node?.behavior?.methods,
      functions: node?.behavior?.functions,
    })) {
      const entry = Object.entries(collection ?? {}).find(([, contract]) => contract.displayName === displayName);
      if (entry) return `behavior.${collectionName}.${entry[0]}`;
    }
    return null;
  }

  static #readNodePath(node, surface) {
    let value = node;
    for (const segment of String(surface ?? '').split('.')) {
      value = value?.[segment];
      if (value == null) return null;
    }
    return value;
  }

  static #resolveLocalModule(sourcePath, moduleName, admittedPaths) {
    if (!sourcePath || typeof moduleName !== 'string' || !moduleName.startsWith('.')) return null;
    const base = this.#normalizeRelativePath(path.posix.join(path.posix.dirname(sourcePath), moduleName));
    const candidates = [base];
    if (!path.posix.extname(base)) {
      for (const extension of LOCAL_MODULE_EXTENSIONS) candidates.push(`${base}${extension}`);
      for (const extension of LOCAL_MODULE_EXTENSIONS) candidates.push(path.posix.join(base, `index${extension}`));
    }
    return candidates.find((candidate) => admittedPaths.has(candidate)) ?? null;
  }

  static #normalizeRelativePath(value) {
    return path.posix.normalize(String(value ?? '').replaceAll('\\', '/')).replace(/^\.\//, '');
  }

  static #nodeName(endpoint) {
    return String(endpoint).split('#', 1)[0];
  }
}

// 3. FileBlock Builder Domain Class
export class CodebaseFileBlockBuilder {
  static async build({
    input, readFileBlock, readFileBlockMetadata = null, auditLogger = null,
  }) {
    const { files } = input.fileSet;
    const generator = new CodebaseFileBlockCacheGenerator({ root: input.root, fileOwner: input.fileOwner });
    const results = await this.#mapConcurrent(files, async (file) => {
      const { content, contentHash, metadataHit } = input.contentByPath.get(file.path);
      const fingerprint = CodebaseFileBlockCacheGenerator.fileFingerprint({
        filePath: file.path,
        contentHash,
      });
      const cachedMetadata = readFileBlockMetadata
        ? readFileBlockMetadata(input.root, file.path, fingerprint)
        : null;
      if (cachedMetadata && cachedMetadata.fingerprint === fingerprint) {
        return { block: null, reused: true, metadataHit };
      }
      const cached = readFileBlock
        ? readFileBlock(input.root, file.path, fingerprint)
        : null;
      if (cached) {
        const projection = cached.value?.projection ?? cached.value?.ast ?? cached;
        return {
          block: {
            root_id: input.root,
            filePath: file.path,
            fingerprint,
            mtimeMs: file.mtimeMs,
            size: file.size,
            contentHash,
            nodes: projection.nodes ?? [],
            edges: projection.edges ?? [],
            ...(cached.value?.ast ? { ast: cached.value.ast } : cached.ast ? { ast: cached.ast } : {}),
            value: cached.value,
          },
          reused: true,
          metadataHit,
        };
      }
      const generated = await generator.generate({
        filePath: file.path,
        mtimeMs: file.mtimeMs,
        content,
        contentHash,
      });
      for (const diagnostic of generated.diagnostics ?? []) {
        auditLogger?.event('ctx.frontend.diagnostic', {
          level: 'warn',
          owner: 'codebase',
          file: file.path,
          code: diagnostic.code,
          message: diagnostic.message,
        });
      }
      const ast = generated.block.ast ?? {
        format: 'ctx.ast.v1',
        language: this.languageForPath(file.path),
        parser_version: 'unavailable',
        root: { kind: 'unavailable', path: file.path },
      };
      const valueAst = {
        ...ast,
        nodes: generated.block.nodes,
        edges: generated.block.edges,
        source_text: content,
        capability: generated.diagnostics?.length || ast.parser_version === 'unavailable' || ast.parser_version?.startsWith('partial-')
          ? 'partial'
          : (ast.capability ?? 'guaranteed'),
        ...(generated.diagnostics?.length ? { diagnostics: generated.diagnostics } : {}),
      };
      return {
        block: {
          root_id: input.root, filePath: file.path, fingerprint, mtimeMs: file.mtimeMs, size: file.size, contentHash, nodes: generated.block.nodes, edges: generated.block.edges, ast: valueAst, value: { ast: valueAst },
        },
        reused: false,
        metadataHit: false,
      };
    }, CODEBASE_ADMISSION_CONCURRENCY);

    const blocks = results.map((result) => result.block).filter(Boolean);
    const rebuiltPaths = new Set(results.filter((result) => !result.reused).map((result) => result.block.filePath));
    const metadataPaths = new Set(results
      .filter((result) => result.block && result.reused && !result.metadataHit)
      .map((result) => result.block.filePath));
    const reusedBlocks = results.filter((result) => result.reused).length;

    const projection = blocks.length === files.length
      ? CodebaseReferenceProjector.projectLocalReferences(blocks, files.map((file) => file.path))
      : { blocks };
    const publishedBlocks = blocks.filter((block) => rebuiltPaths.has(block.filePath) || metadataPaths.has(block.filePath));
    const snapshot = this.flattenBlocks(projection.blocks);
    auditLogger?.event('ctx.codebase.blocks', {
      owner: 'codebase',
      files_total: files.length,
      files_reused: reusedBlocks,
      files_parsed: rebuiltPaths.size,
      files_published: publishedBlocks.length,
    });
    return {
      ...snapshot,
      // The in-memory projection must see the complete current generation.
      // Only changed blocks are written by the coordinator; returning just
      // those here would make a fresh ContextDb omit unchanged files.
      blocks,
      publishBlocks: publishedBlocks,
      blockPaths: files.map((file) => file.path),
      fileAsts: blocks.flatMap((block) => (block.ast ? [this.fileAstRecord(block)] : [])),
      cacheStats: {
        admitted: files.length,
        file_block_count: files.length,
        file_count: files.length,
        reused: reusedBlocks,
        rebuilt: rebuiltPaths.size,
        removed: 0,
      },
    };
  }

  static fileAstRecord(block) {
    return {
      file_path: block.filePath,
      format: block.ast.format ?? 'ctx.ast.v1',
      language: block.ast.language ?? this.languageForPath(block.filePath),
      parser_version: block.ast.parser_version ?? block.ast.version ?? 'unknown',
      ast: block.ast,
    };
  }

  static languageForPath(filePath) {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    return ['js', 'mjs', 'cjs', 'jsx'].includes(extension)
      ? 'javascript'
      : ['ts', 'tsx'].includes(extension) ? 'typescript' : extension || 'unknown';
  }

  static flattenBlocks(blocks) {
    return {
      nodes: blocks.flatMap((block) => block.nodes),
      edges: blocks.flatMap((block) => block.edges),
    };
  }

  static async #mapConcurrent(items, mapper, concurrency) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    };
    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
  }
}

// 4. Compatibility adapter and public loader entry point
export class CodebaseLoader {
  constructor({ definition = CODEBASE_OWNER_DEFINITION } = {}) {
    this.definition = definition;
  }

  async load({ root, fileBlockStore = null, auditLogger = null }) {
    const input = await this.definition.admit(root);
    return new OwnerCacheCoordinator({
      name: this.definition.name,
      producerGeneration: this.definition.producerGeneration,
      produce: (payload) => this.definition.build(payload),
      fileBlockStore,
      auditLogger,
    }).load({ root, input });
  }

  async status({ root, fileBlockStore = null, auditLogger = null }) {
    const input = await this.definition.admit(root);
    return new OwnerCacheCoordinator({
      name: this.definition.name,
      producerGeneration: this.definition.producerGeneration,
      produce: (payload) => this.definition.build(payload),
      fileBlockStore,
      auditLogger,
    }).status({ root, input });
  }
}

export function projectLocalReferences(blocks, admittedPaths) {
  return CodebaseReferenceProjector.projectLocalReferences(blocks, admittedPaths);
}
