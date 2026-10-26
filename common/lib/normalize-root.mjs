import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';

// Single root-normalization authority (handbook: ownership-root).
// Every module that receives a root parameter must call this function instead
// of path.resolve; inventing a second normalization rule is a boundary defect.
// cache keys may also use it: root-scoped identity stays rule-consistent.

export function normalizeRoot(rootValue) {
  const resolved = path.resolve(rootValue);
  const master = path.join(resolved, 'master');
  if (
    isDirectory(path.join(resolved, '.bare'))
    && isDirectory(master)
    && hasProjectEntry(master)
  ) {
    return master;
  }
  return resolved;
}

export function isProjectContainer(root) {
  if (hasProjectEntry(root)) return false;
  let repoChildCount = 0;
  let dirents;
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const child = path.join(root, dirent.name);
    if (
      existsSync(path.join(child, '.git'))
      || existsSync(path.join(child, '.bare'))
      || existsSync(path.join(child, 'CLAUDE.md'))
      || existsSync(path.join(child, 'AGENTS.md'))
    ) {
      repoChildCount += 1;
      if (repoChildCount >= 3) return true;
    }
  }
  return false;
}

function hasProjectEntry(root) {
  return existsSync(path.join(root, 'CLAUDE.md'))
    || existsSync(path.join(root, 'AGENTS.md'))
    || existsSync(path.join(root, 'package.json'))
    || existsSync(path.join(root, 'Cargo.toml'))
    || existsSync(path.join(root, 'pyproject.toml'))
    || existsSync(path.join(root, 'handbook', 'README.md'))
    || existsSync(path.join(root, 'handbook', '🧩_Blocks'));
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
