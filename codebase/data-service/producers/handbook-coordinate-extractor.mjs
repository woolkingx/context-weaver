import crypto from 'node:crypto';

import { ownerManifest, sha256Text } from '../../../common/lib/source-fingerprint.mjs';
import {
  HANDBOOK_CHAPTERS_DIR,
  HANDBOOK_INDEX_PATH,
  HANDBOOK_SOURCE,
  HandbookStore,
  isHandbookSourceBoundaryError,
} from '../../handbook/unit-block-store.mjs';

const MAX_SUMMARY_CHARS = 720;

export async function handbookInputManifest(root, producerGeneration = 'handbook-unit-v1') {
  const store = await HandbookStore.open(root);
  try {
    const files = await Promise.all([
      { path: store.indexPath },
      ...store.blockFiles.map((file) => ({ path: file.path })),
    ].map(async ({ path }) => {
      const metadata = await store.fsx.stat(path);
      const content = await store.fsx.readText(path);
      return {
        path, mtimeMs: metadata.mtimeMs, size: metadata.size, sha256: sha256Text(content),
      };
    }));
    return ownerManifest({
      fileSet: { files },
      policyInputs: await store.fsx.inputMetadataForFingerprint(),
      extraInputs: [`handbook-source:${HANDBOOK_SOURCE}`],
      producerGeneration,
    });
  } finally {
    store.close();
  }
}

export class HandbookCoordinateExtractor {
  static async extract({ root, queryText = '' } = {}) {
    let store;
    try {
      store = await HandbookStore.open(root);
    } catch (error) {
      if (isHandbookSourceBoundaryError(error)) return unavailableResult(error.message, [error.code]);
      throw error;
    }

    try {
      const index = await store.readIndex();
      const blocks = store.blocks();
      const relations = store.relations();
      const chapters = buildChapters(index, blocks, relations, queryText);
      return {
        root: '.',
        source: HANDBOOK_SOURCE,
        formats: ['md', 'xml'],
        capability: 'guaranteed',
        freshness: 'fresh',
        count: chapters.length,
        chapters,
        blocks,
        relations,
        diagnostics: store.stats().unresolved.map((relation) => (
          `${relation.sourceId}: unresolved ${relation.type} target ${relation.targetId}`
        )),
      };
    } finally {
      store.close();
    }
  }
}

export function handbookGraph(coordinate) {
  if (coordinate.capability === 'unavailable') return { nodes: [], edges: [] };
  const chapters = coordinate.chapters ?? [];
  const blocks = coordinate.blocks ?? [];
  const relations = coordinate.relations ?? [];
  const rootStructure = {
    kind: 'handbook_source',
    root: coordinate.root ?? '.',
    source: coordinate.source ?? HANDBOOK_SOURCE,
    formats: coordinate.formats ?? ['md', 'xml'],
    capability: coordinate.capability ?? 'unknown',
    freshness: coordinate.freshness ?? 'unknown',
    chapterCount: chapters.length,
    blockCount: blocks.length,
    chapters: Object.fromEntries(chapters.map((chapter) => [chapter.slug, {
      path: chapter.path,
      sourceFingerprint: chapter.sourceFingerprint,
    }])),
    links: {},
  };
  const nodes = [{
    name: 'ctx.handbook',
    structure: rootStructure,
    behavior: {
      read: { returns: 'current Handbook unit blocks' },
      project: { returns: 'ctx.handbook.chapter.* and ctx.handbook.block.* canonical facets' },
      links: {},
    },
  }];
  const edges = [];

  for (const chapter of chapters) {
    const chapterBlocks = blocks.filter((block) => normalizeSlug(block.chapter) === chapter.slug);
    nodes.push({
      name: chapter.name,
      structure: {
        kind: 'handbook',
        semanticRole: chapter.semanticRole,
        source: chapter.path,
        title: chapter.title,
        summary: chapter.summary,
        headings: chapter.headings,
        links: chapter.links,
        sourceFingerprint: chapter.sourceFingerprint,
        capability: coordinate.capability,
        freshness: coordinate.freshness,
      },
      behavior: {
        read: { path: chapter.path, output: 'bounded Handbook source slice' },
        select: { query: chapter.query, score: chapter.score },
        blocks: Object.fromEntries(chapterBlocks.map((block) => [block.id, true])),
      },
    });
    edges.push({
      frompath: `ctx.handbook#structure.chapters.${chapter.slug}`,
      topath: `${chapter.name}#structure`,
    });
  }

  const chapterNames = new Set(chapters.map((chapter) => chapter.slug));
  for (const block of blocks) {
    const name = `ctx.handbook.block.${block.id}`;
    const blockRelations = relations.filter((relation) => relation.sourceId === block.id);
    nodes.push({
      name,
      structure: {
        kind: 'handbook_block',
        id: block.id,
        chapter: block.chapter,
        tags: block.tags,
        source: block.sourcePath,
        content: block.content,
        ...(block.contentRef ? { contentRef: block.contentRef } : {}),
        sourceFingerprint: block.fingerprint,
      },
      behavior: {
        read: { path: block.sourcePath, output: 'unit block' },
        relations: relationSurface(blockRelations),
      },
    });
    const chapterName = `ctx.handbook.chapter.${normalizeSlug(block.chapter)}`;
    if (chapterNames.has(normalizeSlug(block.chapter))) {
      edges.push({
        frompath: `${chapterName}#behavior.blocks.${block.id}`,
        topath: `${name}#structure`,
      });
    }
  }

  for (const relation of relations) {
    const sourceName = `ctx.handbook.block.${relation.sourceId}`;
    const targetName = chapterNames.has(normalizeSlug(relation.targetId))
      ? `ctx.handbook.chapter.${normalizeSlug(relation.targetId)}`
      : `ctx.handbook.block.${relation.targetId}`;
    edges.push({
      frompath: `${sourceName}#behavior.relations.${relation.type}.${relation.targetId}`,
      topath: `${targetName}#structure`,
      kind: relation.type,
    });
  }
  return { nodes, edges };
}

function relationSurface(relations) {
  const surface = {};
  for (const relation of relations) {
    surface[relation.type] ??= {};
    surface[relation.type][relation.targetId] = true;
  }
  return surface;
}

function buildChapters(index, blocks, relations, queryText) {
  const chapterIds = [...new Set(blocks.map((block) => block.chapter).filter(Boolean))];
  const order = readingOrder(index, chapterIds);
  const chapters = [{
    name: 'ctx.handbook.chapter.index',
    slug: 'index',
    path: HANDBOOK_INDEX_PATH,
    title: 'Context Weaver Handbook',
    semanticRole: 'navigation',
    summary: summarize(index),
    headings: extractHeadings(index),
    links: [],
    sourceFingerprint: fingerprint(index),
    order: 0,
    query: queryText,
    score: scoreChapter(queryText, HANDBOOK_INDEX_PATH, index, []),
    diagnostics: [],
  }];

  for (const [position, chapterId] of order.entries()) {
    const group = blocks.filter((block) => block.chapter === chapterId);
    const content = group.map((block) => block.content).filter(Boolean).join('\n\n');
    const chapterRelations = relations.filter((relation) => group.some((block) => block.id === relation.sourceId) && relation.type !== 'part_of');
    const slug = normalizeSlug(chapterId);
    chapters.push({
      name: `ctx.handbook.chapter.${slug}`,
      slug,
      path: group[0]?.sourcePath ?? `${HANDBOOK_CHAPTERS_DIR}/${slug}.xml`,
      title: titleForChapter(chapterId),
      semanticRole: chapterRole(slug),
      summary: summarize(content),
      headings: group.map((block) => block.id),
      links: chapterRelations.map((relation) => ({
        label: relation.type,
        target: relation.targetId,
        local: blocks.some((block) => block.id === relation.targetId),
      })),
      sourceFingerprint: fingerprint(group.map((block) => block.fingerprint).join('|')),
      order: position + 1,
      query: queryText,
      score: scoreChapter(queryText, `${chapterId} ${content}`, content, group.map((block) => block.id)),
      diagnostics: [],
    });
  }
  return chapters;
}

function readingOrder(index, chapterIds) {
  const code = String(index).match(/```text\s*([\s\S]*?)```/u)?.[1] ?? '';
  const ordered = [...code.matchAll(/[a-z][a-z-]+/gu)].map((match) => match[0]);
  return [...new Set([...ordered, ...chapterIds])].filter((chapter) => chapterIds.includes(chapter));
}

function titleForChapter(chapter) {
  return chapter.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

function chapterRole(slug) {
  return slug === 'selection_policy' ? 'selection-policy' : slug;
}

function normalizeSlug(value) {
  return String(value ?? '').replace(/-/g, '_');
}

function extractHeadings(content) {
  return String(content).split(/\r?\n/u).filter((line) => /^#{1,4}\s+/u.test(line)).map((line) => line.replace(/^#{1,4}\s+/u, '').trim());
}

function summarize(content) {
  const compact = String(content).replace(/^#{1,6}\s+.*$/gmu, '').replace(/[ `*_]/gu, '').replace(/\s+/gu, ' ')
    .trim();
  if (compact.length <= MAX_SUMMARY_CHARS) return compact;
  return `${compact.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

function scoreChapter(query, path, content, headings) {
  const terms = String(query).toLowerCase().split(/[^a-z0-9_$-]+/gu).filter((term) => term.length >= 3);
  if (terms.length === 0) return 1;
  const haystack = `${path} ${content} ${headings.join(' ')}`.toLowerCase();
  return terms.filter((term) => haystack.includes(term)).length / terms.length;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function unavailableResult(message, diagnostics = []) {
  return {
    root: null,
    source: HANDBOOK_SOURCE,
    formats: ['md', 'xml'],
    capability: 'unavailable',
    freshness: 'unknown',
    count: 0,
    chapters: [],
    blocks: [],
    relations: [],
    diagnostics: [message, ...diagnostics],
  };
}
