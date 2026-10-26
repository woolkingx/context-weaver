import { basename, resolve as pathResolve } from 'node:path';
import { SkillCoordinateExtractor } from '../extractors/skill-coordinate-extractor.mjs';
import { FileOwner } from '../../common/owners/files-owner.mjs';
import { SkillPathResolver } from '../extractors/skill-paths.mjs';
import { ownerManifest, sha256Text } from '../../common/lib/source-fingerprint.mjs';

const SECTION_RE = /^## .+/m;

export async function inputFingerprint(root, version = 'v1') {
  return (await inputManifest(root, version)).fingerprint;
}

export async function inputManifest(root, producerGeneration = 'skills-v1') {
  const cwd = pathResolve(root);
  await FileOwner.forRoot(cwd);
  const files = [];
  const policyInputs = [];
  const extraInputs = [];
  for (const source of SkillPathResolver.getSkillSources(cwd)) {
    let fsx;
    try {
      fsx = await FileOwner.forRoot(source.absolutePath);
    } catch (error) {
      if (error.code !== 'ROOT_NOT_FOUND') throw error;
      extraInputs.push(`skill-source-missing:${source.scope}:${source.absolutePath}:${source.pathPrefix}`);
      continue;
    }
    policyInputs.push(...await fsx.inputMetadataForFingerprint());
    const sourceFiles = await fsx.listAdmittedFiles({
      maxFiles: Infinity,
      withMtime: true,
      acceptExtension: (extension) => extension === 'md',
    });
    for (const file of sourceFiles.files) {
      if (basename(file.path) !== 'SKILL.md') continue;
      const content = await fsx.readText(file.path);
      files.push({
        root_id: fsx.root, path: file.path, mtimeMs: file.mtimeMs, size: file.size ?? Buffer.byteLength(content), sha256: sha256Text(content),
      });
    }
    extraInputs.push(`skill-source:${source.scope}:${source.absolutePath}:${source.pathPrefix}`);
  }
  return ownerManifest({
    fileSet: { files },
    policyInputs,
    extraInputs,
    producerGeneration,
  });
}

export async function produce(root) {
  const cwd = pathResolve(root);
  const result = await SkillCoordinateExtractor.extract({ root: cwd });
  const nodes = [];
  const edges = [];

  for (const skill of result.skills ?? []) {
    const scope = skill.scope ?? 'project';
    const { name } = skill;
    const filePath = skill.path;

    let body = '';
    try {
      body = await readSkillText(filePath, cwd);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'FILTERED_PATH') throw error;
    }

    const header = scope === 'global' ? `[global] ${filePath}` : filePath;
    const content = `${header}\n${body}`.slice(0, 800) || skill.description || '';
    const sections = splitSections(body);
    const structure = {
      kind: 'skill',
      scope,
      path: filePath,
      content,
      sections: {},
    };
    for (let i = 0; i < sections.length; i++) {
      const heading = sections[i].match(/^#{1,4}\s+(.+)/m)?.[1]?.trim() ?? `section-${i}`;
      structure.sections[pathKey(heading)] = {
        heading,
        content: sections[i].slice(0, 400),
      };
    }
    nodes.push({ name, structure, behavior: {} });
  }

  const manifest = await inputManifest(root, 'skills-file-v1');
  const blocks = nodes.map((node) => {
    const sourcePath = node.structure.path.replace(/^global:/, '');
    const manifestFile = manifest.files.find((file) => sourcePath === file.path || sourcePath.endsWith(`/${file.path}`));
    if (!manifestFile) throw new Error(`Skill producer emitted a source outside FileOwner admission: ${node.structure.path}`);
    return {
      root_id: manifestFile.root_id,
      filePath: manifestFile.path,
      fingerprint: manifestFile.sha256,
      content_hash: manifestFile.sha256,
      mtime_ms: manifestFile.mtimeMs,
      size: manifestFile.size,
      value: {
        name: node.name,
        scope: node.structure.scope,
        path: sourcePath,
        content: node.structure.content,
        sections: node.structure.sections ?? {},
      },
    };
  });
  return {
    nodes, edges, blocks, blockPaths: blocks.map((block) => block.filePath),
  };
}

function pathKey(value) {
  return String(value).replace(/[^A-Za-z0-9_$:-]+/g, '_').replace(/^_+|_+$/g, '') || 'section';
}

async function readSkillText(filePath, root) {
  if (!filePath) return '';
  const location = SkillPathResolver.resolveSkillPathToLocation(filePath, root);
  if (!location) return '';
  if (!location.relativePath) {
    return '';
  }
  const fsx = await FileOwner.forRoot(location.absoluteRoot);
  return fsx.readText(location.relativePath);
}

function splitSections(content) {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  const sections = [];
  let current = [];

  for (const line of lines) {
    if (SECTION_RE.test(line) && current.length > 0) {
      const text = current.join('\n').trim();
      if (text) sections.push(text);
      current = [line];
    } else {
      current.push(line);
    }
  }
  const last = current.join('\n').trim();
  if (last) sections.push(last);
  return sections;
}
