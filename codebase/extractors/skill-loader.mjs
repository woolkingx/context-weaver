import path from 'node:path';

import { extractHeader } from '../../common/lib/frontmatter.mjs';
import { DEFAULT_IGNORE_NAMES } from '../../common/lib/file-scan.mjs';
import { SkillPathResolver } from './skill-paths.mjs';

// skill 載入/列舉。固定掃描邏輯:
//   references/ 下某目錄含 SKILL.md → 子 skill; 否則 → 純文件/資源。
const RESOURCE_EXT = new Set(['.md', '.json', '.yaml', '.yml', '.html', '.mjs', '.js']);

export class SkillLoader {
  constructor({
    globalRoot, globalSources, projectRoot, fileOwnerForRoot,
  } = {}) {
    if (typeof fileOwnerForRoot !== 'function') {
      throw new TypeError('SkillLoader requires the Unified Data Service source capability.');
    }
    this.fileOwnerForRoot = fileOwnerForRoot;
    if (globalSources !== undefined) {
      this.globalSources = globalSources;
    } else if (globalRoot !== undefined) {
      this.globalSources = globalRoot === null
        ? []
        : [{ absolutePath: path.resolve(globalRoot), pathPrefix: `global:${path.resolve(globalRoot)}`, scope: 'global' }];
    } else {
      this.globalSources = SkillPathResolver.getConfiguredGlobalSkillSources(projectRoot);
    }
  }

  #buildRoots(projectRoot) {
    const absoluteProject = path.resolve(projectRoot ?? process.cwd());
    const roots = [];
    roots.push(SkillPathResolver.getProjectSkillSource(absoluteProject));
    for (const source of this.globalSources) {
      roots.push({ scope: source.scope ?? 'global', absolutePath: path.resolve(source.absolutePath) });
    }
    return roots;
  }

  // 依 name 找 skill 目錄 (全域 + 可選 project)。回 absolute dir 或 null。
  async locate({ name, projectRoot } = {}) {
    const roots = this.#buildRoots(projectRoot);
    for (const root of roots) {
      const rootPath = root.scope === 'project' ? root.absolutePath : path.resolve(root.absolutePath);
      let fsx;
      try {
        fsx = await this.fileOwnerForRoot(rootPath);
      } catch (error) {
        if (error?.code === 'ROOT_NOT_FOUND' && root.scope === 'project') continue;
        throw error;
      }
      const found = await findSkillDir(fsx, name, '.', 0);
      if (found) return found;
    }
    return null;
  }

  // load: 主 skill 全文; 其餘(子 skill + references) 只載檔頭。
  //   into: 點名要深入載全文的子項名清單 (string[])。被點名的載全文,其餘只檔頭。
  //   scripts/ 不載 (用法在 SKILL.md 正文)。
  async load({ name, projectRoot, into = [] } = {}) {
    const dir = await this.locate({ name, projectRoot });
    if (!dir) return { object: 'SkillLoad', name, found: false };
    const selected = new Set(into);
    const fsx = await this.fileOwnerForRoot(dir);

    const body = await safeRead(fsx, 'SKILL.md');
    const refs = [];
    const refDir = 'references';
    for (const entry of await safeReaddir(fsx, refDir)) {
      const full = path.join(refDir, entry.name);
      if (entry.isDirectory()) {
        const childMd = path.join(full, 'SKILL.md');
        const childBody = await safeRead(fsx, childMd);
        if (childBody == null) continue; // 非子 skill 的目錄 (如 agents/) 跳過
        const deep = selected.has(entry.name);
        refs.push({
          kind: 'sub-skill',
          name: entry.name,
          path: path.join(dir, childMd),
          ...(deep ? { content: childBody } : { header: extractHeader(childBody) }),
        });
      } else if (RESOURCE_EXT.has(path.extname(entry.name))) {
        const content = await safeRead(fsx, full);
        const deep = selected.has(entry.name) || selected.has(path.basename(entry.name, path.extname(entry.name)));
        refs.push({
          kind: 'file',
          name: entry.name,
          path: path.join(dir, full),
          ...(deep ? { content } : { header: extractHeader(content) }),
        });
      }
    }
    return {
      object: 'SkillLoad', name, found: true, dir, content: body, references: refs,
    };
  }

  // list: skill + reference + 目錄樹 (遞迴: skill node vs file node)
  async list({ projectRoot, maxDepth = 4 } = {}) {
    const roots = this.#buildRoots(projectRoot);
    const trees = [];
    for (const { scope, absolutePath } of roots) {
      let fsx;
      try {
        fsx = await this.fileOwnerForRoot(path.resolve(absolutePath));
      } catch (error) {
        if (error?.code === 'ROOT_NOT_FOUND' && scope === 'project') continue;
        throw error;
      }
      const tree = await buildTree(fsx, '.', 0, maxDepth);
      if (tree) trees.push({ scope, ...tree });
    }
    return { object: 'SkillList', trees };
  }

  // dir: 單一 skill 底下的子目錄+檔名 (給 query 附帶)
  async dir({ name, projectRoot, maxDepth = 3 } = {}) {
    const dir = await this.locate({ name, projectRoot });
    if (!dir) return null;
    return buildTree(await this.fileOwnerForRoot(dir), '.', 0, maxDepth);
  }
}

async function findSkillDir(fsx, name, relativeDir, depth) {
  if (depth > 4) return null;
  for (const entry of await safeReaddir(fsx, relativeDir)) {
    if (DEFAULT_IGNORE_NAMES.has(entry.name)) continue;
    if (!entry.isDirectory()) continue;
    const child = normalizeRelativePath(path.join(relativeDir === '.' ? '' : relativeDir, entry.name));
    if (entry.name === name && await isSkill(fsx, child)) return path.join(fsx.cwd, child);
    const nested = await findSkillDir(fsx, name, child, depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function isSkill(fsx, relativeDir) {
  return (await safeReaddir(fsx, relativeDir)).some((e) => e.isFile() && e.name === 'SKILL.md');
}

// 目錄樹: skill node (有 SKILL.md) / file node / dir node
async function buildTree(fsx, relativeDir, depth, maxDepth) {
  const entries = await safeReaddir(fsx, relativeDir);
  if (entries.length === 0 && depth === 0) return null;
  const node = {
    name: relativeDir === '.' ? path.basename(fsx.cwd) : path.basename(relativeDir),
    type: entries.some((e) => e.isFile() && e.name === 'SKILL.md') ? 'skill' : 'dir',
    children: [],
  };
  if (depth >= maxDepth) return node;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (DEFAULT_IGNORE_NAMES.has(entry.name)) continue;
    const child = normalizeRelativePath(path.join(relativeDir === '.' ? '' : relativeDir, entry.name));
    if (entry.isDirectory()) {
      node.children.push(await buildTree(fsx, child, depth + 1, maxDepth));
    } else {
      node.children.push({ name: entry.name, type: 'file' });
    }
  }
  return node;
}

async function safeRead(fsx, relativePath) {
  try {
    return await fsx.readText(relativePath);
  } catch {
    return null;
  }
}
async function safeReaddir(fsx, relativePath) {
  try {
    return await fsx.readdir(relativePath);
  } catch {
    return [];
  }
}
function normalizeRelativePath(value) {
  return String(value).split(path.sep).join('/').replace(/^\.\//, '');
}
