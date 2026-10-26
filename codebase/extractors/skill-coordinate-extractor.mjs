import path from 'node:path';
import { normalizeRoot } from '../../common/lib/normalize-root.mjs';

import { parseFrontmatter } from '../../common/lib/frontmatter.mjs';
import { DEFAULT_IGNORE_NAMES } from '../../common/lib/file-scan.mjs';
import { ConfigOwner } from '../../common/config/config-loader.mjs';
import { FileOwner } from '../../common/owners/files-owner.mjs';
import { SkillPathResolver } from './skill-paths.mjs';

export class SkillCoordinateExtractor {
  static async extract({
    root, queryText = '', includeGlobal = true, globalSkillSources = null,
  } = {}) {
    const repoRoot = normalizeRoot(root);
    await FileOwner.forRoot(repoRoot);
    const configuredGlobalSources = globalSkillSources ?? SkillPathResolver.getSkillSources(repoRoot).slice(1);
    const skillSources = [
      SkillPathResolver.getProjectSkillSource(repoRoot),
      ...(includeGlobal ? configuredGlobalSources : []),
    ];
    const skills = [];
    const seen = new Set();
    const config = new ConfigOwner().resolve({ root: repoRoot }).values;

    const maxDepth = config.maxSkillScanDepth;
    for (const source of skillSources) {
      let fsx;
      try {
        fsx = await FileOwner.forRoot(source.absolutePath);
      } catch (error) {
        if (error?.code === 'ROOT_NOT_FOUND') continue;
        throw error;
      }
      const skillFiles = await listSkillFiles(fsx, maxDepth);
      for (const file of skillFiles) {
        const content = await fsx.readText(file.relativePath);
        const metadata = parseFrontmatter(content);
        const summary = firstHeading(content);
        const name = metadata.name || path.basename(path.dirname(file.relativePath));
        const skill = {
          name,
          path: SkillPathResolver.buildSkillPath(source, file.relativePath),
          title: summary || name,
          description: metadata.description || '',
          summary,
          scope: source.scope,
          procedureHeadings: procedureHeadings(content),
        };

        // 同名 skills 只保留 project 的優先來源 (同名 global 重複會干擾後續查詢/owner 邏輯).
        if (source.scope === 'project' || !seen.has(name)) {
          if (source.scope !== 'project' && seen.has(name)) {
            continue;
          }
          seen.add(name);
          skills.push({
            ...skill,
            node: createSkillNode(skill),
            score: scoreSkill(skill, queryText),
          });
        }
      }
    }

    skills.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

    return {
      root: skills.length > 0 ? (includeGlobal ? 'skills+global' : 'skills') : null,
      count: skills.length,
      skills,
      edges: skills.map((skill) => createSkillEdge(skill)),
    };
  }
}

async function listSkillFiles(fsx, maxDepth) {
  return listSkillFilesRecursive(fsx, '.', 0, maxDepth);
}

async function listSkillFilesRecursive(fsx, relativeDir, depth, maxDepth) {
  let dirents;
  try {
    dirents = await fsx.readdir(relativeDir);
  } catch (error) {
    if (error?.code === 'FILE_NOT_FOUND') return [];
    throw error;
  }

  const files = [];
  for (const dirent of dirents) {
    if (DEFAULT_IGNORE_NAMES.has(dirent.name)) continue;
    const relativePath = normalizeRelativePath(path.join(relativeDir === '.' ? '' : relativeDir, dirent.name));
    if (dirent.isFile() && dirent.name === 'SKILL.md') {
      files.push({
        relativePath,
      });
      continue;
    }
    if (!dirent.isDirectory() || depth >= maxDepth) continue;
    files.push(...await listSkillFilesRecursive(fsx, relativePath, depth + 1, maxDepth));
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function normalizeRelativePath(value) {
  return String(value).split(path.sep).join('/').replace(/^\.\//, '');
}

function firstHeading(content) {
  const line = content.split(/\r?\n/).find((value) => value.startsWith('# '));
  return line ? line.replace(/^#\s+/, '') : '';
}

function procedureHeadings(content) {
  return content
    .split(/\r?\n/)
    .filter((line) => /^#{2,4}\s+/.test(line))
    .map((line) => line.replace(/^#{2,4}\s+/, '').trim())
    .filter(Boolean);
}

function createSkillNode(skill) {
  return {
    object: 'ContextNode',
    id: `skill:${skill.name}`,
    type: 'skill',
    lane: 'skills',
    interactionLayer: 'evidence',
    owner: 'skills',
    path: skill.path,
    range: {
      startLine: 1,
      endLine: 1,
    },
    title: skill.title,
    summary: skill.description || skill.summary || skill.title,
    authorityLevel: 70,
    invalidation: `${skill.path} changes`,
  };
}

function createSkillEdge(skill) {
  return {
    object: 'ContextEdge',
    from: `skill:${skill.name}`,
    to: 'owner:skills',
    rel: 'governs',
    evidence: skill.path,
    confidence: 1,
  };
}

function scoreSkill(skill, queryText) {
  const tokens = normalizeTokens(queryText);
  if (tokens.length === 0) return 1;
  const haystack = normalizeTokens([
    skill.name,
    skill.title,
    skill.description,
    skill.summary,
    skill.procedureHeadings.join(' '),
  ].join(' '));
  if (haystack.length === 0) return 0;
  const matches = tokens.filter((token) => haystack.includes(token)).length;
  return matches === 0 ? 0 : matches / tokens.length;
}

function normalizeTokens(value) {
  return String(value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}
