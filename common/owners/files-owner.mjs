import { AsyncLocalStorage } from 'node:async_hooks';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PathExclusionPolicy } from '../lib/path-exclusion-policy.mjs';

const FILE_STAT_CONCURRENCY = 32;

export class FileOwnerError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'FileOwnerError';
    this.code = code;
    this.metadata = metadata;
  }
}
export class FsFileSet {
  constructor({ root, files }) {
    this.owner = 'files'; this.root = path.resolve(root); this.files = files;
  }
}
export class FileOwner {
  static #session = new AsyncLocalStorage();

  static async withSession(work) {
    return this.#session.getStore() ? work() : this.#session.run(new Map(), work);
  }

  static async forRoot(root, options = {}) {
    const cwd = path.resolve(root); const store = this.#session.getStore(); if (!store) return createFileOwner(cwd, options); const key = `${cwd}\0${options.gitCommand ?? 'git'}`; if (!store.has(key)) store.set(key, createFileOwner(cwd, options)); try {
      return await store.get(key);
    } catch (error) {
      store.delete(key); throw error;
    }
  }

  constructor({ root, policy }) {
    this.owner = 'files'; this.root = path.resolve(root); this.cwd = this.root; this.policy = policy; this.fsx = this;
  }

  assertAllowed(targetPath) {
    try {
      return this.policy.resolveRelative(targetPath);
    } catch (error) {
      if (error instanceof FileOwnerError) throw error;
      throw new FileOwnerError(error?.code ?? 'INVALID_PATH', error?.message ?? String(error), {
        reason: error?.reason ?? null,
      });
    }
  }

  async stat(targetPath) {
    const safe = this.assertAllowed(targetPath);
    try {
      return await stat(safe.absolutePath);
    } catch (error) {
      throw normalizeFsError('stat', safe.relativePath, error);
    }
  }

  async readdir(targetPath = '.') {
    const safe = targetPath === '.'
      ? { absolutePath: this.root, relativePath: '' }
      : this.assertAllowed(targetPath);
    try {
      const entries = await readdir(safe.absolutePath, { withFileTypes: true });
      return entries.filter((entry) => {
        const relativePath = path.posix.join(safe.relativePath, entry.name);
        return !this.policy.check(relativePath, { isDirectory: entry.isDirectory() }).excluded;
      });
    } catch (error) {
      throw normalizeFsError('readdir', safe.relativePath || '.', error);
    }
  }

  async readText(targetPath) {
    const safe = this.assertAllowed(targetPath);
    try {
      return await readFile(safe.absolutePath, 'utf8');
    } catch (error) {
      throw normalizeFsError('read', safe.relativePath, error);
    }
  }

  inputFilesForFingerprint() {
    return this.policy.inputFilesForFingerprint();
  }

  async inputMetadataForFingerprint() {
    return this.policy.inputMetadataForFingerprint();
  }

  async collectFiles(targetPath = '.', options = {}) {
    return this.#collectAdmittedFiles(targetPath, {
      acceptExtension: options.acceptExtension ?? (() => true),
      maxFiles: options.maxFiles ?? Infinity,
      withMtime: options.withMtime ?? false,
      withSize: options.withSize ?? false,
    });
  }

  async listAdmittedFiles({
    targetPath = '.', acceptExtension = () => true, maxFiles = Infinity, withMtime = false, withSize = false,
  } = {}) {
    const files = await this.#collectAdmittedFiles(targetPath, {
      acceptExtension, maxFiles, withMtime, withSize,
    });
    return new FsFileSet({ root: this.root, files });
  }

  async #collectAdmittedFiles(targetPath, options) {
    const files = [];
    const statRequests = [];
    await this.#collect(targetPath, files, options, statRequests);
    const stats = await mapConcurrent(
      statRequests,
      ({ path: filePath }) => this.stat(filePath),
      FILE_STAT_CONCURRENCY,
    );
    for (const [index, info] of stats.entries()) {
      const request = statRequests[index];
      if (options.withMtime) files[request.fileIndex].mtimeMs = info.mtimeMs;
      if (options.withSize) files[request.fileIndex].size = info.size;
    }
    return files;
  }

  async #collect(dir, files, options, statRequests) {
    if (files.length >= options.maxFiles) return;
    let entries;
    try {
      entries = await this.readdir(dir);
    } catch (error) {
      if (error.code === 'FILTERED_PATH') return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= options.maxFiles || !entry.name) break;
      if (this.policy.ignoreNames.has(entry.name)) continue;
      const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      if (this.policy.check(rel, { isDirectory: entry.isDirectory() }).excluded) continue;
      if (entry.isDirectory()) {
        await this.#collect(rel, files, options, statRequests); continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).slice(1).toLowerCase();
      if (!options.acceptExtension(extension, rel)) continue;
      const fileIndex = files.push({
        absolutePath: path.join(this.root, rel),
        path: rel,
        relativePath: rel,
        name: entry.name,
        extension,
        readText: () => this.readText(rel),
      }) - 1;
      if (options.withMtime || options.withSize) statRequests.push({ fileIndex, path: rel });
    }
  }
}

async function mapConcurrent(items, mapper, concurrency) {
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
async function createFileOwner(root, options) {
  let metadata;
  try {
    metadata = await stat(root);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new FileOwnerError('ROOT_NOT_FOUND', `Project root does not exist: ${root}`, { path: root, systemCode: error.code });
    }
    throw normalizeFsError('root', root, error);
  }
  if (!metadata.isDirectory()) {
    throw new FileOwnerError('ROOT_NOT_DIRECTORY', `Project root is not a directory: ${root}`, { path: root, systemCode: 'ENOTDIR' });
  }
  return new FileOwner({ root, policy: await PathExclusionPolicy.forCwd(root, options) });
}

function normalizeFsError(operation, targetPath, error) {
  if (error instanceof FileOwnerError) return error;
  const code = error?.code === 'ENOENT'
    ? 'FILE_NOT_FOUND'
    : error?.code === 'ENOTDIR'
      ? 'NOT_DIRECTORY'
      : error?.code === 'EACCES' || error?.code === 'EPERM'
        ? 'PERMISSION_DENIED'
        : 'FILESYSTEM_ERROR';
  return new FileOwnerError(code, `${operation} failed for ${targetPath}: ${error?.message ?? String(error)}`, {
    path: targetPath,
    operation,
    systemCode: error?.code ?? null,
  });
}
export { FileOwnerError as FilteredFilesystemError };
// FileOwner's exclusion submodule: it builds the FileOwner whose policy (PathExclusionPolicy)
// applies the Git and safety exclusions. Composition, not inheritance (no-owner-inheritance).
export class FilteredFilesystem {
  static async forCwd(cwd, options = {}) {
    const root = path.resolve(cwd);
    return new FileOwner({ root, policy: await PathExclusionPolicy.forCwd(root, options) });
  }
}
export default FileOwner;
