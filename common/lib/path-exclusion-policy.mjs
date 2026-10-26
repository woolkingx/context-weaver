import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const GIT_COMMAND_TIMEOUT_MS = 10_000;

export const DEFAULT_EXCLUDED_SEGMENTS = new Set([
  '.backup',
  '.bare',
  '.cache',
  '.cleanup',
  '.codegraph',
  '.etc',
  '.git',
  '.hg',
  '.next',
  '.nuxt',
  '.svn',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'temp',
  'third_party',
  'tmp',
  'vendor',
]);

// Hidden roots that contain deliberate agent inputs; .block preserves legacy Handbook layout detection.
export const DEFAULT_VISIBLE_HIDDEN_SEGMENTS = new Set(['.agents', '.block', '.claude', '.codex']);

export class GlobalDefaultExclusionPolicy {
  constructor({
    excludedSegments = DEFAULT_EXCLUDED_SEGMENTS,
    visibleHiddenSegments = DEFAULT_VISIBLE_HIDDEN_SEGMENTS,
  } = {}) {
    this.excludedSegments = excludedSegments;
    this.visibleHiddenSegments = visibleHiddenSegments;
  }

  check(relativePath) {
    const rel = normalizeRelativePath(relativePath);
    const segment = rel.split('/').find((part) => (
      this.excludedSegments.has(part)
      || (part.startsWith('.') && !this.visibleHiddenSegments.has(part))
    ));
    if (!segment) return { excluded: false, reason: null };
    return { excluded: true, reason: `global-default:${segment}` };
  }
}

export class GitExclusionUnavailableError extends Error {
  constructor(cwd, cause) {
    super(`Git is required to apply repository exclusions, but the Git executable was not found for ${path.resolve(cwd)}. Install Git or use a non-Git project with the local exclusion fallback.`, { cause });
    this.name = 'GitExclusionUnavailableError';
    this.code = 'GIT_UNAVAILABLE';
    this.metadata = { cwd: path.resolve(cwd) };
  }
}

export class GitExclusionTimeoutError extends Error {
  constructor(cwd, cause) {
    super(`Git did not complete within ${GIT_COMMAND_TIMEOUT_MS} ms for ${path.resolve(cwd)}. Check the repository/worktree and rerun.`, { cause });
    this.name = 'GitExclusionTimeoutError';
    this.code = 'GIT_TIMEOUT';
    this.metadata = { cwd: path.resolve(cwd), timeoutMs: GIT_COMMAND_TIMEOUT_MS };
  }
}

export class GitExclusionPolicy {
  static async load(cwd, { gitCommand = 'git', discoverIgnoreFiles = true } = {}) {
    const root = path.resolve(cwd);
    const gitState = await detectGitState(root, gitCommand);
    if (gitState === 'unavailable') {
      throw new GitExclusionUnavailableError(root);
    }
    if (gitState === 'repository') return loadGitPolicy(root, gitCommand);
    return loadFilesystemPolicy(root, gitCommand, { discoverIgnoreFiles });
  }

  constructor({
    cwd, inputFiles = [], rules = [], admittedPaths = null, admittedDirectories = null,
  } = {}) {
    this.cwd = path.resolve(cwd ?? '.');
    this.inputFiles = inputFiles;
    this.rules = rules;
    this.admittedPaths = admittedPaths;
    this.admittedDirectories = admittedDirectories;
  }

  check(relativePath, { isDirectory = false } = {}) {
    const rel = normalizeRelativePath(relativePath);
    if (this.admittedPaths && this.admittedDirectories) {
      if (!existsSync(path.resolve(this.cwd, rel))) {
        return { excluded: false, reason: null };
      }
      const admitted = this.admittedPaths.has(rel) || this.admittedDirectories.has(rel);
      return admitted
        ? { excluded: false, reason: null }
        : { excluded: true, reason: 'git:standard-excludes' };
    }
    let excluded = false;
    let reason = null;
    for (const rule of this.rules) {
      if (!rule.matches(rel, { isDirectory })) continue;
      excluded = !rule.negated;
      reason = excluded ? `git:${rule.source}` : null;
    }
    return { excluded, reason };
  }
}

async function detectGitState(root, gitCommand) {
  if (!existsSync(root)) return 'not-repository';
  try {
    await execFileAsync(gitCommand, ['rev-parse', '--show-toplevel'], {
      cwd: root,
      timeout: GIT_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return 'repository';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'unavailable';
    if (error?.code === 'ETIMEDOUT') throw new GitExclusionTimeoutError(root, error);
    return 'not-repository';
  }
}

async function loadGitPolicy(root, gitCommand) {
  const [{ stdout: worktreeOutput }, { stdout: filesOutput }] = await Promise.all([
    execGit(root, gitCommand, ['rev-parse', '--show-toplevel']),
    execGit(root, gitCommand, ['ls-files', '--cached', '--others', '--exclude-standard', '--full-name', '-z']),
  ]);
  const worktreeRoot = path.resolve(worktreeOutput.trim());
  const admittedPaths = new Set();
  const admittedDirectories = new Set(['.']);
  const gitIgnoreFiles = new Set();

  for (const rawPath of filesOutput.split('\0').filter(Boolean)) {
    const absolutePath = path.resolve(worktreeRoot, rawPath);
    if (rawPath === '.gitignore' || rawPath.endsWith('/.gitignore')) gitIgnoreFiles.add(absolutePath);
    const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) continue;
    admittedPaths.add(relativePath);
    const segments = relativePath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      admittedDirectories.add(segments.slice(0, index).join('/'));
    }
  }

  const inputFiles = await gitInputFiles(root, worktreeRoot, gitCommand, gitIgnoreFiles);
  return new GitExclusionPolicy({
    cwd: root, inputFiles, admittedPaths, admittedDirectories,
  });
}

async function loadFilesystemPolicy(root, gitCommand, { discoverIgnoreFiles = true } = {}) {
  const ignoreFiles = discoverIgnoreFiles ? await discoverGitIgnoreFiles(root) : [];
  const rootIgnore = path.join(root, '.gitignore');
  if (!ignoreFiles.includes(rootIgnore)) ignoreFiles.unshift(rootIgnore);
  const infoExclude = path.join(root, '.git', 'info', 'exclude');
  const globalExclude = await resolveGlobalExcludesFile(root, gitCommand);
  const inputFiles = [...ignoreFiles, infoExclude, ...(globalExclude ? [globalExclude] : [])];
  const sources = [];

  for (const file of inputFiles) {
    const text = await safeRead(file);
    if (text == null) continue;
    const baseDir = file === globalExclude
      ? root
      : path.dirname(file) === path.join(root, '.git', 'info')
        ? root
        : path.dirname(file);
    sources.push({
      file,
      basePath: normalizeRelativePath(path.relative(root, baseDir)),
      rules: parseIgnoreRules(text, normalizeRelativePath(path.relative(root, baseDir))),
    });
  }

  return new GitExclusionPolicy({ cwd: root, inputFiles, rules: sources.flatMap((source) => source.rules) });
}

async function gitInputFiles(root, worktreeRoot, gitCommand, gitIgnoreFiles) {
  const inputFiles = new Set();
  const pointer = path.join(worktreeRoot, '.git');
  if (await exists(pointer)) inputFiles.add(pointer);

  for (const file of gitIgnoreFiles) inputFiles.add(file);

  const [infoExclude, globalExclude] = await Promise.all([
    gitPath(root, gitCommand, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']),
    resolveGlobalExcludesFile(root, gitCommand),
  ]);
  if (infoExclude) inputFiles.add(infoExclude);
  if (globalExclude) inputFiles.add(globalExclude);
  return [...inputFiles];
}

async function execGit(cwd, gitCommand, args) {
  try {
    return await execFileAsync(gitCommand, args, {
      cwd,
      timeout: GIT_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new GitExclusionUnavailableError(cwd, error);
    if (error?.code === 'ETIMEDOUT') throw new GitExclusionTimeoutError(cwd, error);
    throw error;
  }
}

async function gitPath(cwd, gitCommand, args) {
  try {
    const { stdout } = await execGit(cwd, gitCommand, args);
    const value = stdout.trim();
    return value ? path.resolve(cwd, value) : null;
  } catch (error) {
    if (error?.code === 'GIT_TIMEOUT') throw error;
    return null;
  }
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export class PathExclusionPolicy {
  static async forCwd(cwd, options = {}) {
    const git = await GitExclusionPolicy.load(cwd, options);
    return new PathExclusionPolicy({
      cwd,
      globalDefault: new GlobalDefaultExclusionPolicy(),
      git,
    });
  }

  constructor({ cwd, globalDefault = new GlobalDefaultExclusionPolicy(), git = new GitExclusionPolicy({ cwd }) } = {}) {
    this.cwd = path.resolve(cwd ?? '.');
    this.globalDefault = globalDefault;
    this.git = git;
    // FileOwner uses this read-only view to avoid descending into globally
    // excluded directories before asking the full policy matcher.
    this.ignoreNames = DEFAULT_EXCLUDED_SEGMENTS;
  }

  resolveRelative(targetPath) {
    if (!targetPath || path.isAbsolute(targetPath)) {
      throw Object.assign(new Error(`Invalid path: ${targetPath}`), { code: 'ABSOLUTE_PATH' });
    }
    const absolutePath = path.resolve(this.cwd, targetPath);
    const relativePath = normalizeRelativePath(path.relative(this.cwd, absolutePath));
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw Object.assign(new Error(`Path escapes cwd: ${targetPath}`), { code: 'OUTSIDE_CWD' });
    }
    const isDirectory = existsSync(absolutePath) && statSync(absolutePath).isDirectory();
    const result = this.check(relativePath, { isDirectory });
    if (result.excluded) {
      throw Object.assign(new Error(`Path excluded: ${targetPath}`), { code: 'FILTERED_PATH', reason: result.reason });
    }
    return { absolutePath, relativePath };
  }

  inputFilesForFingerprint() {
    return this.git.inputFiles;
  }

  async inputMetadataForFingerprint() {
    return Promise.all(this.git.inputFiles.map(async (file) => {
      try {
        return { path: file, mtimeMs: (await stat(file)).mtimeMs };
      } catch {
        return { path: file, mtimeMs: null };
      }
    }));
  }

  check(relativePath, options = {}) {
    const global = this.globalDefault.check(relativePath, options);
    if (global.excluded) return global;
    const git = this.git.check(relativePath, options);
    if (git.excluded) return git;
    return { excluded: false, reason: null };
  }
}

class GitIgnoreRule {
  constructor({
    pattern, basePath = '', negated = false, directoryOnly = false, anchored = false, source = '',
  }) {
    this.pattern = pattern;
    this.basePath = basePath;
    this.negated = negated;
    this.directoryOnly = directoryOnly;
    this.anchored = anchored;
    this.source = source;
    this.hasSlash = pattern.includes('/');
    this.regex = globToRegex(pattern, { anchored, hasSlash: this.hasSlash });
  }

  matches(relativePath, { isDirectory = false } = {}) {
    const rel = normalizeRelativePath(relativePath);
    if (this.basePath && rel !== this.basePath && !rel.startsWith(`${this.basePath}/`)) return false;
    const scoped = this.basePath ? rel.slice(this.basePath.length).replace(/^\//, '') : rel;
    if (!scoped) return false;

    if (this.directoryOnly && !isDirectory && !this.matchesDirectoryAncestor(scoped)) return false;
    if (!this.hasSlash) {
      if (this.anchored) return scoped === this.pattern || scoped.startsWith(`${this.pattern}/`);
      return scoped.split('/').some((segment) => this.regex.test(segment));
    }
    return this.regex.test(scoped);
  }

  matchesDirectoryAncestor(scopedPath) {
    if (!this.hasSlash) return scopedPath.split('/').includes(this.pattern);
    return scopedPath === this.pattern || scopedPath.startsWith(`${this.pattern}/`) || this.regex.test(scopedPath);
  }
}

function isDefaultExcludedSegment(segment) {
  return DEFAULT_EXCLUDED_SEGMENTS.has(segment)
    || (segment.startsWith('.') && !DEFAULT_VISIBLE_HIDDEN_SEGMENTS.has(segment));
}

async function discoverGitIgnoreFiles(root) {
  const files = [];
  await walk(root, '');
  return files.sort((left, right) => left.localeCompare(right));

  async function walk(currentRoot, relativeDir) {
    let dirents;
    try {
      dirents = await readdir(path.join(currentRoot, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const rel = normalizeRelativePath(path.join(relativeDir, dirent.name));
      if (dirent.isFile() && dirent.name === '.gitignore') {
        files.push(path.join(root, rel));
        continue;
      }
      if (isDefaultExcludedSegment(dirent.name)) continue;
      if (dirent.isDirectory()) await walk(root, rel);
    }
  }
}

async function resolveGlobalExcludesFile(cwd, gitCommand = 'git') {
  let value = '';
  try {
    const result = await execFileAsync(gitCommand, ['config', '--path', '--get', 'core.excludesfile'], { cwd });
    value = result.stdout.trim();
  } catch {
    return null;
  }
  if (!value) return null;
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(cwd, value);
}

async function safeRead(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function parseIgnoreRules(text, basePath) {
  const rules = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }

    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);

    const directoryOnly = line.endsWith('/');
    if (directoryOnly) line = line.slice(0, -1);

    line = normalizeRelativePath(line);
    if (!line) continue;

    rules.push(new GitIgnoreRule({
      pattern: line,
      basePath,
      negated,
      directoryOnly,
      anchored,
      source: `${basePath || '.'}/.gitignore:${line}`,
    }));
  }
  return rules;
}

function globToRegex(pattern, { anchored, hasSlash }) {
  const escaped = pattern
    .split('')
    .map((char, index, chars) => {
      if (char === '*' && chars[index + 1] === '*') return '.*';
      if (char === '*' && chars[index - 1] === '*') return '';
      if (char === '*') return '[^/]*';
      if (char === '?') return '[^/]';
      return /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
    })
    .join('');
  if (!hasSlash) return new RegExp(`^${escaped}$`);
  return new RegExp(anchored ? `^${escaped}(?:/.*)?$` : `(^|/)${escaped}(?:/.*)?$`);
}

export function normalizeRelativePath(value) {
  return String(value ?? '')
    .split(path.sep)
    .join('/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}
