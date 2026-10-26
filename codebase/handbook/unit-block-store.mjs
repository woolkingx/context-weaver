import { createHash } from 'node:crypto';
import path from 'node:path';

import { FileOwner } from '../../common/owners/files-owner.mjs';
import { normalizeRoot } from '../../common/lib/normalize-root.mjs';
import { ErrorObject } from '../../common/lib/error-object.mjs';

export const HANDBOOK_ROOT = 'handbook';
export const HANDBOOK_INDEX_PATH = `${HANDBOOK_ROOT}/README.md`;
export const HANDBOOK_CHAPTERS_DIR = `${HANDBOOK_ROOT}/<chapter>`;
export const HANDBOOK_SOURCE = `${HANDBOOK_INDEX_PATH} + ${HANDBOOK_ROOT}/<chapter>/*.xml`;

const SOURCE_BOUNDARY_ERROR_CODES = new Set([
  'HANDBOOK_SOURCE_MISSING',
  'HANDBOOK_INDEX_MISSING',
  'HANDBOOK_INDEX_NOT_FILE',
  'HANDBOOK_BLOCKS_DIR_MISSING',
  'HANDBOOK_BLOCKS_NOT_DIRECTORY',
  'HANDBOOK_BLOCKS_EMPTY',
  'HANDBOOK_CASE_MISMATCH',
  'HANDBOOK_UNAVAILABLE',
]);

const TRAVERSABLE_RELATIONS = new Set(['part_of', 'depends_on', 'extends', 'requires', 'references', 'links']);
const RELATION_TYPES = new Set(['part_of', 'follows', 'depends_on', 'extends', 'requires', 'conflicts_with', 'references', 'links']);
const RESERVED_WORDS = new Set([
  'global', 'local', 'horizontal_matrix', 'block', 'blocks', 'chapters', 'rels',
  'part_of', 'follows', 'depends_on', 'extends', 'requires', 'conflicts_with', 'content_ref',
]);

export class HandbookFormatError extends ErrorObject {
  constructor(message, code = 'HANDBOOK_FORMAT_ERROR', metadata = {}) {
    super({
      code, message, cause: metadata.cause ?? null, context: metadata,
    });
    this.name = 'HandbookFormatError';
    this.metadata = metadata;
  }
}

export function isHandbookSourceBoundaryError(error) {
  return error instanceof HandbookFormatError && SOURCE_BOUNDARY_ERROR_CODES.has(error.code);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export class ObsidianHandbookParser {
  static parseYaml(yaml) {
    const properties = {};
    for (const line of String(yaml).split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const propMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u);
      if (!propMatch) continue;
      const key = propMatch[1];
      const val = propMatch[2].trim();
      if (val.startsWith('[') && val.endsWith(']')) {
        properties[key] = val.slice(1, -1)
          .split(',')
          .map((item) => item.trim().replace(/^["']|["']$/gu, ''))
          .filter(Boolean);
      } else {
        const unquoted = val.replace(/^["']|["']$/gu, '');
        const num = Number(unquoted);
        properties[key] = Number.isFinite(num) && String(num) === unquoted ? num : unquoted;
      }
    }
    return properties;
  }

  static parseNote(raw, sourcePath, { chapter = null } = {}) {
    const source = String(raw).trim();
    const id = path.posix.basename(sourcePath, '.md');
    let frontmatter = {};
    let content = source;
    const fmMatch = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u);
    if (fmMatch) {
      content = source.slice(fmMatch[0].length).trim();
      frontmatter = ObsidianHandbookParser.parseYaml(fmMatch[1]);
    }
    const rawTags = Array.isArray(frontmatter.tags)
      ? frontmatter.tags
      : (typeof frontmatter.tags === 'string' ? frontmatter.tags.split(',') : []);
    const tags = [...new Set(rawTags.map((t) => String(t).trim()).filter(Boolean))].sort();

    const linkMatches = [...source.matchAll(/\[\[(?:handbook\/)?([^\]|#]+)(?:[|#][^\]]*)?\]\]/gu)];
    const relations = [];
    const seenRelations = new Set();
    for (const match of linkMatches) {
      const target = match[1].trim().replace(/\.md$/u, '');
      if (target === id) continue;
      const key = `depends_on:${target}`;
      if (seenRelations.has(key)) continue;
      seenRelations.add(key);
      relations.push({ type: 'depends_on', target });
    }

    const fingerprint = createHash('sha256').update(String(raw)).digest('hex').slice(0, 16);
    return {
      id,
      tags,
      chapter: chapter ?? id,
      content,
      sourcePath,
      fingerprint,
      relations,
    };
  }
}

export class XmlHandbookParser {
  static parseUnitBlock(raw, sourcePath, { chapter = null } = {}) {
    const source = String(raw).trim();
    const match = source.match(/^<unit\b([^>]*)>([\s\S]*?)<\/unit>([\s\S]*)$/u);
    if (!match) {
      throw new HandbookFormatError(`${sourcePath}: expected one flat <unit> root element.`, 'INVALID_BLOCK_XML', { sourcePath });
    }
    const attributes = XmlHandbookParser.parseAttributes(match[1]);
    XmlHandbookParser.assertAttributes(attributes, ['id', 'type', 'tags'], sourcePath, 'unit');
    const { id } = attributes;
    if (!attributes.type) throw new HandbookFormatError(`${sourcePath}: unit type is required.`, 'INVALID_BLOCK_XML', { sourcePath });
    const filenameId = path.posix.basename(sourcePath, '.xml');
    const expectedId = chapter && filenameId.startsWith(`${chapter}.`)
      ? filenameId.slice(chapter.length + 1)
      : filenameId;
    if (!id) throw new HandbookFormatError(`${sourcePath}: block id is required.`, 'MISSING_BLOCK_ID', { sourcePath });
    if (!chapter && id !== expectedId && id !== filenameId) {
      throw new HandbookFormatError(`${sourcePath}: id '${id}' does not match filename '${filenameId}'.`, 'BLOCK_ID_FILENAME_MISMATCH', { sourcePath, id, expectedId: filenameId });
    }
    const contentBody = match[2].trim();
    if (/<relation\b/u.test(contentBody)) {
      throw new HandbookFormatError(`${sourcePath}: relations must be sibling elements outside <unit>.`, 'INVALID_BLOCK_XML', { sourcePath });
    }
    const contentMatch = contentBody.match(/^<content>([\s\S]*?)<\/content>$/u);
    if (contentBody && !contentMatch) {
      throw new HandbookFormatError(`${sourcePath}: unit body must contain only <content>.`, 'INVALID_BLOCK_XML', { sourcePath });
    }
    const relationSource = match[3].trim();
    const relationMatches = [...relationSource.matchAll(/<relation\b([^>]*)\/\s*>/gu)];
    const relationRemainder = relationSource.replace(/<relation\b[^>]*\/\s*>/gu, '').trim();
    if (relationRemainder) {
      throw new HandbookFormatError(`${sourcePath}: relations must be flat sibling elements after <unit>.`, 'INVALID_BLOCK_XML', { sourcePath });
    }
    const relations = relationMatches.map((relationMatch) => {
      const relation = XmlHandbookParser.parseAttributes(relationMatch[1]);
      XmlHandbookParser.assertAttributes(relation, ['from', 'type', 'to'], sourcePath, 'relation');
      if (relation.from !== id || !relation.to) {
        throw new HandbookFormatError(`${sourcePath}: relation.from must match the unit id and relation.to is required.`, 'INVALID_BLOCK_XML', { sourcePath });
      }
      return { type: relation.type, target: relation.to };
    });
    const content = XmlHandbookParser.decodeXml(contentMatch?.[1]?.trim() ?? '');
    const tags = (attributes.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean).sort();
    const reserved = [id, ...tags].filter((value) => RESERVED_WORDS.has(value));
    if (reserved.length > 0) throw new HandbookFormatError(`${sourcePath}: reserved word(s) cannot be used as id/tags: ${reserved.join(', ')}.`, 'HANDBOOK_RESERVED_WORD', { sourcePath, reserved });
    const invalidRelations = relations.filter((relation) => !RELATION_TYPES.has(relation.type));
    if (invalidRelations.length > 0) throw new HandbookFormatError(`${sourcePath}: unknown relation type(s): ${invalidRelations.map((relation) => relation.type).join(', ')}.`, 'UNKNOWN_RELATION_TYPE', { sourcePath, invalidRelations });
    return {
      id,
      tags,
      chapter: chapter ?? relations.find((relation) => relation.type === 'part_of')?.target ?? null,
      content,
      sourcePath,
      fingerprint: createHash('sha256').update(String(raw)).digest('hex').slice(0, 16),
      relations,
    };
  }

  static assertAttributes(attributes, allowed, sourcePath, element) {
    const unknown = Object.keys(attributes).filter((name) => !allowed.includes(name));
    if (unknown.length > 0) {
      throw new HandbookFormatError(
        `${sourcePath}: unsupported ${element} attribute(s): ${unknown.join(', ')}.`,
        'INVALID_BLOCK_XML',
        { sourcePath, element, unknown },
      );
    }
  }

  static parseAttributes(raw) {
    return Object.fromEntries([...String(raw).matchAll(/([A-Za-z_][\w-]*)\s*=\s*["']([^"']*)["']/gu)].map((match) => [match[1], XmlHandbookParser.decodeXml(match[2])]));
  }

  static decodeXml(value) {
    return String(value)
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      .replace(/&quot;/gu, '"')
      .replace(/&apos;/gu, "'")
      .replace(/&amp;/gu, '&');
  }
}

function chapterMembers(chapterId, blocks) {
  return [...blocks.values()].filter((block) => block.chapter === chapterId).map((block) => block.id);
}

export class HandbookStore {
  constructor({
    fsx, format = 'ob', indexPath, blockFiles, records,
  }) {
    this.fsx = fsx;
    this.format = format;
    this.indexPath = indexPath;
    this.blockFiles = blockFiles;
    this.records = records;
    this.cache = { blocks: null, relations: null, outgoing: null };
  }

  static async open(root) {
    const fsx = await FileOwner.forRoot(normalizeRoot(root));
    const files = await discoverHandbookFiles(fsx);
    const records = [];
    try {
      const index = await fsx.readText(files.indexPath);
      for (const file of files.blockFiles) {
        const raw = await fsx.readText(file.path);
        const record = files.format === 'ob'
          ? ObsidianHandbookParser.parseNote(raw, file.path, { chapter: file.chapter })
          : XmlHandbookParser.parseUnitBlock(raw, file.path, { chapter: file.chapter });
        const duplicate = records.find((previous) => previous.id === record.id);
        if (duplicate) {
          throw new HandbookFormatError(`Duplicate Handbook block id: ${record.id}.`, 'HANDBOOK_BLOCK_DUPLICATE_SOURCE', {
            id: record.id, paths: [duplicate.sourcePath, file.path],
          });
        }
        records.push(record);
      }
      validateIndexRoute(index, records, files.format);
    } catch (error) {
      if (error instanceof HandbookFormatError) throw error;
      throw new HandbookFormatError(`Unable to load Handbook unit blocks: ${error.message}`, 'HANDBOOK_READ_ERROR', { cause: error });
    }

    return new HandbookStore({
      fsx, format: files.format, indexPath: files.indexPath, blockFiles: files.blockFiles, records,
    });
  }

  close() {
    this.records = [];
    this.cache = { blocks: null, relations: null, outgoing: null };
  }

  async readIndex() {
    return this.fsx.readText(this.indexPath);
  }

  blocks() {
    if (!this.cache.blocks) {
      this.cache.blocks = this.records.map((record) => ({
        id: record.id,
        tags: [...record.tags],
        chapter: record.chapter,
        content: record.content,
        sourcePath: record.sourcePath,
        fingerprint: record.fingerprint,
      })).sort((left, right) => left.id.localeCompare(right.id));
    }
    return this.cache.blocks;
  }

  relations() {
    if (!this.cache.relations) {
      this.cache.relations = this.records.flatMap((record) => record.relations.map((relation) => ({
        sourceId: record.id,
        type: relation.type,
        targetId: relation.target,
      }))).sort((left, right) => (
        left.sourceId.localeCompare(right.sourceId)
        || left.type.localeCompare(right.type)
        || left.targetId.localeCompare(right.targetId)
      ));
    }
    return this.cache.relations;
  }

  outgoingRelations() {
    if (!this.cache.outgoing) {
      this.cache.outgoing = new Map();
      for (const relation of this.relations()) {
        if (!this.cache.outgoing.has(relation.sourceId)) this.cache.outgoing.set(relation.sourceId, []);
        this.cache.outgoing.get(relation.sourceId).push(relation);
      }
    }
    return this.cache.outgoing;
  }

  select({ tags = [], ids = [], chapter = null } = {}) {
    const selected = new Set(this.blocks()
      .filter((block) => (ids.length === 0 || ids.includes(block.id)))
      .filter((block) => !chapter || block.chapter === chapter)
      .filter((block) => tags.length === 0 || tags.some((tag) => block.tags.includes(tag)))
      .map((block) => block.id));
    const outgoing = this.outgoingRelations();
    const blockIds = new Set(this.blocks().map((block) => block.id));
    const queue = [...selected];
    while (queue.length > 0) {
      const current = queue.pop();
      for (const relation of outgoing.get(current) ?? []) {
        if (!TRAVERSABLE_RELATIONS.has(relation.type) || selected.has(relation.targetId)) continue;
        if (!blockIds.has(relation.targetId)) continue;
        selected.add(relation.targetId);
        queue.push(relation.targetId);
      }
    }
    return this.blocks().filter((block) => selected.has(block.id));
  }

  search(queryText, { tags = [], chapter = null, ids = [] } = {}) {
    const query = String(queryText ?? '').trim().toLowerCase();
    const queryTokens = query.split(/\s+/u).filter(Boolean);
    return this.blocks()
      .filter((block) => (ids.length === 0 || ids.includes(block.id)))
      .filter((block) => !chapter || block.chapter === chapter)
      .filter((block) => tags.length === 0 || tags.some((tag) => block.tags.includes(tag)))
      .map((block) => {
        if (queryTokens.length === 0) return { block, score: 0 };
        const idLower = block.id.toLowerCase();
        const contentLower = block.content.toLowerCase();
        const tagsLower = block.tags.map((t) => t.toLowerCase());
        let score = 0;
        for (const token of queryTokens) {
          if (idLower === token) score += 50;
          else if (idLower.includes(token)) score += 20;
          if (tagsLower.includes(token)) score += 30;
          else if (tagsLower.some((t) => t.includes(token))) score += 15;
          const count = (contentLower.match(new RegExp(escapeRegExp(token), 'gu')) ?? []).length;
          score += Math.min(count * 2, 40);
        }
        return { block, score };
      })
      .filter(({ score }) => queryTokens.length === 0 || score > 0)
      .sort((left, right) => right.score - left.score || left.block.id.localeCompare(right.block.id))
      .map(({ block }) => block);
  }

  stats() {
    const blocks = this.blocks();
    const chapterGroups = new Map();
    for (const block of blocks) {
      const chapter = block.chapter ?? '(root)';
      const group = chapterGroups.get(chapter) ?? { chapter, count: 0, contentChars: 0 };
      group.count += 1;
      group.contentChars += block.content.length;
      chapterGroups.set(chapter, group);
    }
    const chapters = [...chapterGroups.values()]
      .sort((left, right) => left.chapter.localeCompare(right.chapter))
      .map((group) => ({
        chapter: group.chapter,
        blockCount: group.count,
        averageContentChars: Math.floor(group.contentChars / group.count),
      }));
    const tags = blocks.flatMap((block) => block.tags)
      .reduce((counts, tag) => ({ ...counts, [tag]: (counts[tag] ?? 0) + 1 }), {});
    const duplicateContent = new Map();
    for (const block of blocks) {
      if (!duplicateContent.has(block.content)) duplicateContent.set(block.content, []);
      duplicateContent.get(block.content).push(block.id);
    }
    const duplicateGroups = [...duplicateContent.values()]
      .filter((ids) => ids.length > 1)
      .sort((left, right) => left[0].localeCompare(right[0]));
    const chapterIds = [...new Set(this.records.map((record) => record.chapter).filter(Boolean)), 'README', 'index'];
    const blockIds = new Set(blocks.map((block) => block.id));
    const unresolved = this.relations()
      .filter((relation) => !blockIds.has(relation.targetId) && !chapterIds.includes(relation.targetId));
    const relationCounts = Object.fromEntries(this.relations()
      .reduce((counts, relation) => counts.set(relation.type, (counts.get(relation.type) ?? 0) + 1), new Map()));
    return {
      chapters,
      topTags: Object.entries(tags).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 15),
      duplicateGroups,
      unresolved,
      relationCounts,
      total: { blocks: this.records.length, chapters: chapterIds.length, relations: this.relations().length },
    };
  }

  tree({ start, maxDepth = 3 } = {}) {
    const blocks = new Map(this.blocks().map((block) => [block.id, block]));
    const chapterIds = new Set([...blocks.values()].map((block) => block.chapter).filter(Boolean));
    if (!blocks.has(start) && !chapterIds.has(start)) throw new HandbookFormatError(`Unknown Handbook block or chapter: ${start}`, 'UNKNOWN_BLOCK', { start });
    const chapterView = (id) => ({ id, blockIds: [...blocks.values()].filter((block) => block.chapter === id).map((block) => block.id), blockCount: [...blocks.values()].filter((block) => block.chapter === id).length });
    const outgoing = this.outgoingRelations();
    const startIsChapter = chapterIds.has(start) && !blocks.has(start);
    const result = [startIsChapter
      ? { depth: 0, relation: null, chapter: chapterView(start) }
      : { depth: 0, relation: null, block: blocks.get(start) }];
    const seen = new Set([startIsChapter ? `chapter:${start}` : `block:${start}`]);
    const queue = [{ id: start, kind: startIsChapter ? 'chapter' : 'block', depth: 0 }];
    while (queue.length > 0) {
      const { id, kind, depth } = queue.shift();
      if (depth >= maxDepth) continue;
      const relations = kind === 'chapter'
        ? chapterMembers(id, blocks).map((targetId) => ({ sourceId: id, type: 'contains', targetId }))
        : (outgoing.get(id) ?? []);
      for (const relation of relations) {
        const chapter = chapterIds.has(relation.targetId) ? chapterView(relation.targetId) : null;
        const block = blocks.get(relation.targetId);
        if (!chapter && !block) continue;
        const nextKind = chapter ? 'chapter' : 'block';
        const nextKey = `${nextKind}:${relation.targetId}`;
        if (seen.has(nextKey)) continue;
        seen.add(nextKey);
        result.push({ depth: depth + 1, relation, ...(chapter ? { chapter } : { block }) });
        queue.push({ id: relation.targetId, kind: nextKind, depth: depth + 1 });
      }
      if (kind === 'block' && blocks.get(id)?.chapter && depth + 1 < maxDepth) {
        const chapterId = blocks.get(id).chapter;
        const key = `chapter:${chapterId}`;
        if (!seen.has(key)) {
          seen.add(key);
          const relation = { sourceId: id, type: 'part_of', targetId: chapterId };
          result.push({ depth: depth + 1, relation, chapter: chapterView(chapterId) });
          queue.push({ id: chapterId, kind: 'chapter', depth: depth + 1 });
        }
      }
    }
    return result;
  }
}

async function discoverHandbookFiles(fsx) {
  let rootEntries = [];
  try {
    rootEntries = await fsx.readdir(HANDBOOK_ROOT);
  } catch (error) {
    if (error?.code !== 'FILE_NOT_FOUND' && error?.code !== 'FILTERED_PATH') throw error;
  }
  const indexEntry = rootEntries.find((entry) => entry.name === 'README.md');
  const indexExists = Boolean(indexEntry?.isFile());
  const indexPathExists = Boolean(indexEntry);

  const mdFiles = rootEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      name: entry.name,
      path: `${HANDBOOK_ROOT}/${entry.name}`,
      chapter: entry.name.replace(/\.md$/u, ''),
    }));

  if (indexExists && mdFiles.length > 0) {
    return { format: 'ob', indexPath: HANDBOOK_INDEX_PATH, blockFiles: mdFiles };
  }

  const blockFiles = [];
  const chapterDirectories = rootEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const directory of chapterDirectories) {
    const chapterPath = `${HANDBOOK_ROOT}/${directory.name}`;
    const entries = await fsx.readdir(chapterPath);
    blockFiles.push(...entries
      .filter((entry) => entry.isFile() && /\.xml$/u.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => ({ name: entry.name, path: `${chapterPath}/${entry.name}`, chapter: directory.name })));
  }
  if (indexExists && blockFiles.length > 0) return { format: 'xml', indexPath: HANDBOOK_INDEX_PATH, blockFiles };

  const blocksState = (chapterDirectories.length > 0 || mdFiles.length > 0) ? 'directory' : 'missing';
  const rootFiles = rootEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const rootDirectories = rootEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const context = {
    root: fsx.root,
    required: { index: HANDBOOK_INDEX_PATH, chapters: `${HANDBOOK_CHAPTERS_DIR}/*.xml` },
    discovered: {
      handbookFiles: rootFiles.filter((name) => /handbook/iu.test(name)),
      chapterDirectories: rootDirectories.filter((name) => ['core', 'ctx', 'rule', 'skill', 'handbook'].includes(name)),
      expectedIndexPathExists: indexPathExists,
      expectedIndexIsFile: indexExists,
      expectedBlocksState: blocksState,
      xmlBlockCount: blockFiles.length,
      markdownBlockCount: mdFiles.length,
    },
  };

  const caseIndex = rootFiles.find((name) => name.toLowerCase() === 'readme.md' && name !== 'README.md');
  if (caseIndex) {
    throw new HandbookFormatError(
      `Handbook index differs only by case: found ${caseIndex}, expected ${HANDBOOK_INDEX_PATH}.`,
      'HANDBOOK_CASE_MISMATCH',
      { ...context, expectedPath: HANDBOOK_INDEX_PATH, discoveredPath: caseIndex },
    );
  }
  if (indexPathExists && !indexExists) {
    throw new HandbookFormatError(
      `${HANDBOOK_INDEX_PATH} exists but is not a regular file.`,
      'HANDBOOK_INDEX_NOT_FILE',
      { ...context, path: HANDBOOK_INDEX_PATH },
    );
  }
  if (!indexExists && (blocksState === 'directory' || mdFiles.length > 0) && (blockFiles.length > 0 || mdFiles.length > 0)) {
    throw new HandbookFormatError(
      `Handbook block files were found, but ${HANDBOOK_INDEX_PATH} is missing.`,
      'HANDBOOK_INDEX_MISSING',
      context,
    );
  }
  if (indexExists && blocksState === 'missing') {
    throw new HandbookFormatError(
      `${HANDBOOK_INDEX_PATH} exists, but ${HANDBOOK_CHAPTERS_DIR} is missing.`,
      'HANDBOOK_BLOCKS_DIR_MISSING',
      context,
    );
  }
  if (indexExists && blocksState === 'directory' && blockFiles.length === 0 && mdFiles.length === 0) {
    throw new HandbookFormatError(
      `${HANDBOOK_CHAPTERS_DIR} exists but contains no unit blocks.`,
      'HANDBOOK_BLOCKS_EMPTY',
      context,
    );
  }
  throw new HandbookFormatError(
    `Handbook unit-block source is unavailable. Expected ${HANDBOOK_SOURCE}.`,
    'HANDBOOK_SOURCE_MISSING',
    context,
  );
}

function validateIndexRoute(index, records, format = 'xml') {
  if (format === 'ob') {
    const obRows = [...String(index).matchAll(/^\|\s*\[\[(?:handbook\/)?([a-z0-9_-]+)(?:\|[^\]]+)?\]\]\s*\|/gmu)]
      .map((match) => match[1]);
    const readingOrderText = String(index).match(/```text\s*([\s\S]*?)```/u)?.[1] ?? '';
    const readingOrder = [...readingOrderText.matchAll(/[a-z][a-z0-9_-]+/gu)].map((match) => match[0]);
    const actualIds = records.map((record) => record.id).sort();
    const declaredIds = [...new Set(obRows)];
    const missingChapters = actualIds.filter((id) => !declaredIds.includes(id));
    const unknownChapters = declaredIds.filter((id) => !actualIds.includes(id));
    const routeMismatch = readingOrder.length > 0 && declaredIds.length > 0
      && readingOrder.join('|') !== declaredIds.join('|');
    if (obRows.length === 0 || missingChapters.length > 0 || unknownChapters.length > 0 || routeMismatch) {
      throw new HandbookFormatError(
        'Handbook index route does not match the Obsidian note files.',
        'HANDBOOK_INDEX_ROUTE_DRIFT',
        {
          missingChapters, unknownChapters, routeMismatch, expectedOrder: declaredIds,
        },
      );
    }
    return { chapters: declaredIds, blocks: actualIds };
  }

  const legacyRows = [...String(index).matchAll(/^\|\s*([a-z][a-z-]*)\s*\|[^|]*\|\s*([^|]+?)\s*\|\s*$/gmu)]
    .map((match) => ({ chapter: match[1], labels: match[2].split(',').map((value) => value.trim()).filter(Boolean) }));
  const prefixRows = [...String(index).matchAll(/^\|\s*\d+\s*\|[^|]*\|\s*`([a-z][a-z-]*)-\*`\s*\|\s*$/gmu)]
    .map((match) => ({ chapter: match[1], prefix: `${match[1]}-` }));
  const rows = legacyRows.length > 0 ? legacyRows : prefixRows;
  const readingOrderText = String(index).match(/```text\s*([\s\S]*?)```/u)?.[1] ?? '';
  const readingOrder = [...readingOrderText.matchAll(/[a-z][a-z-]+/gu)].map((match) => match[0]);
  const actualByChapter = new Map();
  for (const record of records) {
    if (!actualByChapter.has(record.chapter)) actualByChapter.set(record.chapter, []);
    actualByChapter.get(record.chapter).push(record.id);
  }
  const actualChapters = [...actualByChapter.keys()].sort();
  const normalizedRows = rows.map((row) => {
    if (!row.prefix || actualByChapter.has(row.chapter)) return row;
    const chapter = actualChapters.find((value) => value.startsWith(`${row.chapter}-`));
    return chapter ? { ...row, chapter, prefix: `${chapter}-` } : row;
  });
  const declaredChapters = normalizedRows.map((row) => row.chapter);
  const declaredIds = normalizedRows.flatMap((row) => {
    const chapterIds = actualByChapter.get(row.chapter) ?? [];
    if (row.prefix) return chapterIds.filter((id) => id.startsWith(row.prefix));
    return row.labels.map((label) => chapterIds.find((id) => id === label)
      ?? chapterIds.find((id) => id.endsWith(`-${label}`))
      ?? `${row.chapter}-${label}`);
  });
  const actualIds = records.map((record) => record.id).sort();
  if (rows.length === 0 && actualChapters.length > 0) {
    return { chapters: actualChapters, blocks: actualIds };
  }
  const missingChapters = actualChapters.filter((chapter) => !declaredChapters.includes(chapter));
  const unknownChapters = declaredChapters.filter((chapter) => !actualChapters.includes(chapter));
  const missingIds = actualIds.filter((id) => !declaredIds.includes(id));
  const unknownIds = declaredIds.filter((id) => !actualIds.includes(id));
  const duplicateIds = declaredIds.filter((id, index) => declaredIds.indexOf(id) !== index);
  const expectedOrder = normalizedRows.map((row) => row.chapter);
  const routeMismatch = readingOrder.length > 0 && readingOrder.join('|') !== expectedOrder.join('|');
  if (rows.length === 0 || missingChapters.length || unknownChapters.length || missingIds.length || unknownIds.length || duplicateIds.length || routeMismatch) {
    throw new HandbookFormatError(
      'Handbook index route does not match the unit-block files.',
      'HANDBOOK_INDEX_ROUTE_DRIFT',
      {
        missingChapters, unknownChapters, missingIds, unknownIds, duplicateIds, routeMismatch, expectedOrder,
      },
    );
  }
  return { chapters: expectedOrder, blocks: declaredIds };
}
