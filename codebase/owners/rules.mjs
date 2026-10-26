import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { FileOwner } from '../../common/owners/files-owner.mjs';
import { ownerManifest, sha256Text } from '../../common/lib/source-fingerprint.mjs';

const SECTION_RE = /^#{1,4} .+/m;

export async function inputFingerprint(root, version = 'v1') {
  return (await inputManifest(root, version)).fingerprint;
}

export async function inputManifest(root, producerGeneration = 'rules-v1') {
  const cwd = resolve(root);
  const candidates = [
    { filePath: join(cwd, 'CLAUDE.md'), root: cwd, relativePath: 'CLAUDE.md' },
    { filePath: join(cwd, 'AGENTS.md'), root: cwd, relativePath: 'AGENTS.md' },
    { filePath: join(process.env.HOME ?? '', '.codex', 'AGENTS.md'), root: join(process.env.HOME ?? '', '.codex'), relativePath: 'AGENTS.md' },
  ];
  const files = [];
  const policyInputs = [];
  const extraInputs = [];
  const owners = new Map();
  for (const candidate of candidates) {
    if (candidate.root !== cwd && !existsSync(candidate.root)) {
      extraInputs.push(`missing-rule:${candidate.filePath}`);
      continue;
    }
    let owner = owners.get(candidate.root);
    if (!owner) {
      owner = await FileOwner.forRoot(candidate.root, { discoverIgnoreFiles: false });
      owners.set(candidate.root, owner);
    }
    policyInputs.push(...await owner.inputMetadataForFingerprint());
    try {
      const metadata = await owner.stat(candidate.relativePath);
      const content = await owner.readText(candidate.relativePath);
      files.push({
        root_id: owner.root, path: candidate.relativePath, mtimeMs: metadata.mtimeMs, size: metadata.size, sha256: sha256Text(content),
      });
    } catch (error) {
      if (error?.code !== 'FILE_NOT_FOUND' && error?.code !== 'FILTERED_PATH') throw error;
      extraInputs.push(`missing-rule:${candidate.filePath}`);
    }
  }
  return ownerManifest({
    fileSet: { files },
    policyInputs,
    extraInputs,
    producerGeneration,
  });
}

export async function produce(root) {
  const cwd = resolve(root);
  const candidates = [
    { filePath: join(cwd, 'CLAUDE.md'), root: cwd, relativePath: 'CLAUDE.md' },
    { filePath: join(cwd, 'AGENTS.md'), root: cwd, relativePath: 'AGENTS.md' },
    {
      filePath: join(process.env.HOME ?? '', '.codex', 'AGENTS.md'),
      root: join(process.env.HOME ?? '', '.codex'),
      relativePath: 'AGENTS.md',
    },
  ];
  const owners = new Map();
  const blocks = [];

  for (const candidate of candidates) {
    if (candidate.root !== cwd && !existsSync(candidate.root)) continue;
    let content;
    let owner;
    try {
      owner = owners.get(candidate.root);
      if (!owner) {
        owner = await FileOwner.forRoot(candidate.root, { discoverIgnoreFiles: false });
        owners.set(candidate.root, owner);
      }
      content = await owner.readText(candidate.relativePath);
    } catch (error) {
      if (error?.code === 'FILE_NOT_FOUND' || error?.code === 'FILTERED_PATH') continue;
      throw error;
    }

    const sections = splitSections(content);
    const value = {
      path: candidate.relativePath,
      content: content.slice(0, 4000),
      sections: {},
    };
    for (let i = 0; i < sections.length; i++) {
      const heading = sections[i].match(/^#{1,4}\s+(.+)/m)?.[1]?.trim() ?? `section-${i}`;
      value.sections[pathKey(heading)] = {
        heading,
        content: sections[i].slice(0, 600),
      };
    }
    blocks.push({
      root_id: owner.root,
      file_path: candidate.relativePath,
      fingerprint: sha256Text(content),
      content_hash: sha256Text(content),
      mtime_ms: (await owner.stat(candidate.relativePath)).mtimeMs,
      size: Buffer.byteLength(content),
      value,
    });
  }

  return { blocks, blockPaths: blocks.map((block) => block.file_path) };
}

function pathKey(value) {
  return String(value).replace(/[^A-Za-z0-9_$:-]+/g, '_').replace(/^_+|_+$/g, '') || 'section';
}

function splitSections(content) {
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
