import { HandbookCoordinateExtractor, handbookInputManifest } from './handbook-coordinate-extractor.mjs';
import { normalizeRoot } from '../../../common/lib/normalize-root.mjs';

export async function inputManifest(root, producerGeneration = 'handbook-v1') {
  const manifest = await handbookInputManifest(root, producerGeneration);
  const rootId = normalizeRoot(root);
  return { ...manifest, files: manifest.files.map((file) => ({ ...file, root_id: rootId })) };
}

export async function produce(root) {
  const rootId = normalizeRoot(root);
  const coordinate = await HandbookCoordinateExtractor.extract({ root });
  const manifest = await handbookInputManifest(root, 'handbook-v1');
  const fileByPath = new Map(manifest.files.map((file) => [file.path, file]));
  const sourceBlocks = [
    ...(coordinate.chapters ?? [])
      .filter((chapter) => chapter.path === 'handbook/README.md')
      .map((chapter) => ({ sourcePath: chapter.path, fingerprint: fileByPath.get(chapter.path)?.sha256 ?? chapter.sourceFingerprint, value: { kind: 'handbook_index', content: chapter.summary ?? chapter.title, chapters: Object.fromEntries((coordinate.chapters ?? []).filter((item) => item.path !== 'handbook/README.md').map((item) => [item.slug, { path: item.path, sourceFingerprint: item.sourceFingerprint }])) } })),
    ...(coordinate.blocks ?? []).map((block) => ({
      ...block,
      value: {
        kind: 'handbook_block', id: block.id, chapter: block.chapter ?? null, tags: block.tags ?? [], content: block.content, relations: (coordinate.relations ?? []).filter((relation) => relation.sourceId === block.id).map((relation) => ({ kind: relation.type, target: relation.targetId })),
      },
    })),
  ];
  const resultBlocks = sourceBlocks.map((block) => ({
    root_id: rootId,
    filePath: block.sourcePath,
    fingerprint: fileByPath.get(block.sourcePath)?.sha256 ?? block.fingerprint,
    mtimeMs: fileByPath.get(block.sourcePath)?.mtimeMs ?? null,
    size: fileByPath.get(block.sourcePath)?.size ?? null,
    contentHash: fileByPath.get(block.sourcePath)?.sha256 ?? null,
    value: block.value,
  }));
  return {
    blocks: resultBlocks,
    blockPaths: resultBlocks.map((block) => block.filePath),
  };
}
