import path from 'node:path';

import { createSensorResult } from '../schema/context.mjs';
import { toPosix } from '../../common/lib/file-scan.mjs';
import { FileOwnerError } from '../../common/owners/files-owner.mjs';
import { SkillPathResolver } from '../extractors/skill-paths.mjs';

export class ContentSliceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContentSliceError';
    this.code = code;
  }
}

export class ContentSliceSensor {
  constructor({ globalSkillSources = null, fileOwnerForRoot = null } = {}) {
    this.globalSkillSources = globalSkillSources;
    this.fileOwnerForRoot = fileOwnerForRoot;
    if (typeof fileOwnerForRoot !== 'function') {
      throw new TypeError('ContentSliceSensor requires the Unified Data Service source capability.');
    }
  }

  async slice({
    query, path: targetPath, startLine = 1, endLine, ruleRefs = [],
  } = {}) {
    const repoRoot = path.resolve(query.root);
    const safe = await safeRelativePath(repoRoot, targetPath, {
      globalSkillSources: this.globalSkillSources,
      fileOwnerForRoot: this.fileOwnerForRoot,
    });
    const fileStat = await statFile(safe);
    if (!fileStat.isFile()) {
      throw new ContentSliceError('NOT_FILE', `Path is not a file: ${safe.relativePath}`);
    }

    const content = await safe.fsx.readText(safe.loadPath);
    const lines = content.split(/\r?\n/);
    const start = normalizeLine(startLine, 'startLine');
    const requestedEnd = endLine == null ? start + 49 : normalizeLine(endLine, 'endLine');
    if (requestedEnd < start) {
      throw new ContentSliceError('INVALID_RANGE', 'endLine must be greater than or equal to startLine.');
    }
    if (start > lines.length) {
      throw new ContentSliceError(
        'START_OUT_OF_RANGE',
        `startLine ${start} exceeds file line count ${lines.length}: ${safe.relativePath}`,
      );
    }

    const maxChars = Math.max(1, Number(query.budget?.maxChars ?? 12000));
    const slice = boundedLineSlice(lines, start, requestedEnd, maxChars);
    const excerpt = slice.lines.map(({ lineNumber, text, rendered }) => rendered ?? `${lineNumber}: ${text}`).join('\n');
    const who = ruleRefs.length > 0
      ? `files_direct lane governed by ${ruleRefs.join(', ')}`
      : 'files_direct lane with no active rule file found';

    return createSensorResult({
      route: 'slice',
      tool: 'ContentSliceSensor',
      command: 'internal:slice',
      path: safe.relativePath,
      startLine: start,
      endLine: slice.endLine,
      excerpt,
      score: 1,
      metadata: {
        charCount: excerpt.length,
        requestedStartLine: start,
        requestedEndLine: requestedEnd,
        totalLines: lines.length,
        hitEndOfFile: slice.hitEndOfFile,
        truncated: slice.truncated,
        truncatedByBudget: slice.truncatedByBudget,
        nextStartLine: slice.truncated && !slice.hitEndOfFile ? slice.endLine + 1 : null,
        nextEndLine: slice.truncated && !slice.hitEndOfFile ? requestedEnd : null,
        ruleRefs,
        fiveWOneH: {
          who,
          what: `source slice ${safe.relativePath}:${start}-${slice.endLine}`,
          where: safe.relativePath,
          when: 'fresh',
          why: 'bounded file content evidence requested by slice route',
          how: 'use this excerpt as code evidence or expand the range',
        },
      },
    });
  }
}

async function safeRelativePath(repoRoot, targetPath, { globalSkillSources = null, fileOwnerForRoot } = {}) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new ContentSliceError('MISSING_PATH', 'Missing slice path.');
  }
  const declaredGlobalPath = await resolveDeclaredGlobalPath(targetPath, repoRoot, {
    globalSkillSources,
    fileOwnerForRoot,
  });
  if (declaredGlobalPath) return declaredGlobalPath;
  if (toPosix(targetPath).startsWith('global:/')) {
    throw new ContentSliceError('UNDECLARED_GLOBAL_PATH', `Global path is not declared in config: ${targetPath}`);
  }
  if (path.isAbsolute(targetPath)) {
    throw new ContentSliceError('ABSOLUTE_PATH', `Absolute paths are not allowed: ${targetPath}`);
  }

  const fsx = await fileOwnerForRoot(repoRoot);
  let safe;
  try {
    safe = fsx.assertAllowed(targetPath);
  } catch (error) {
    if (error instanceof FileOwnerError || error?.code === 'OUTSIDE_CWD') {
      if (error.code === 'OUTSIDE_CWD') {
        throw new ContentSliceError('OUTSIDE_ROOT', `Path escapes repo root: ${targetPath}`);
      }
      throw new ContentSliceError(error.code, error.message);
    }
    throw error;
  }
  const { relativePath } = safe;
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new ContentSliceError('OUTSIDE_ROOT', `Path escapes repo root: ${targetPath}`);
  }

  return {
    fsx, loadPath: relativePath, absolutePath: safe.absolutePath, relativePath,
  };
}

async function resolveDeclaredGlobalPath(targetPath, projectRoot, { globalSkillSources, fileOwnerForRoot }) {
  const location = SkillPathResolver.resolveGlobalSkillLocation(targetPath, projectRoot, { globalSkillSources });
  if (!location) return null;
  const fsx = await fileOwnerForRoot(location.absoluteRoot);
  let safe;
  try {
    safe = location.relativePath
      ? fsx.assertAllowed(location.relativePath)
      : { absolutePath: location.absoluteRoot, relativePath: '' };
  } catch (error) {
    if (error instanceof FileOwnerError || error?.code === 'OUTSIDE_CWD') {
      if (error.code === 'OUTSIDE_CWD') {
        throw new ContentSliceError('OUTSIDE_GLOBAL_ROOT', `Global path escapes declared root: ${targetPath}`);
      }
      throw new ContentSliceError(error.code, error.message);
    }
    throw error;
  }

  if (!safe.relativePath || safe.relativePath.startsWith('..') || path.isAbsolute(safe.relativePath)) {
    throw new ContentSliceError('OUTSIDE_GLOBAL_ROOT', `Global path escapes declared root: ${targetPath}`);
  }

  return {
    fsx,
    loadPath: safe.relativePath,
    absolutePath: safe.absolutePath,
    relativePath: location.path,
  };
}

async function statFile(safe) {
  try {
    return await safe.fsx.stat(safe.loadPath);
  } catch (error) {
    if (error?.code === 'FILE_NOT_FOUND') {
      throw new ContentSliceError('MISSING_FILE', `File not found: ${safe.relativePath}`);
    }
    if (error instanceof FileOwnerError) {
      throw new ContentSliceError(error.code, error.message);
    }
    throw error;
  }
}

function normalizeLine(value, fieldName) {
  const line = Number.parseInt(String(value), 10);
  if (!Number.isInteger(line) || line < 1) {
    throw new ContentSliceError('INVALID_LINE', `${fieldName} must be a positive integer.`);
  }
  return line;
}

function boundedLineSlice(lines, startLine, requestedEndLine, maxChars) {
  const selected = [];
  let charCount = 0;
  let truncatedByBudget = false;
  const finalRequestedLine = Math.min(requestedEndLine, lines.length);

  for (let lineNumber = startLine; lineNumber <= finalRequestedLine; lineNumber += 1) {
    const text = lines[lineNumber - 1] ?? '';
    const rendered = `${lineNumber}: ${text}`;
    const nextCharCount = charCount + (selected.length > 0 ? 1 : 0) + rendered.length;
    if (nextCharCount > maxChars) {
      truncatedByBudget = true;
      if (selected.length === 0) {
        const truncatedRendered = rendered.slice(0, maxChars);
        const truncatedText = text.slice(0, Math.max(0, maxChars - `${lineNumber}: `.length));
        selected.push({ lineNumber, text: truncatedText, rendered: truncatedRendered });
        charCount = truncatedRendered.length;
      }
      break;
    }
    selected.push({ lineNumber, text });
    charCount = nextCharCount;
  }

  const endLine = selected.length > 0 ? selected[selected.length - 1].lineNumber : startLine;
  const hitEndOfFile = endLine >= lines.length;
  const truncatedByRange = endLine < finalRequestedLine;
  return {
    lines: selected,
    endLine,
    hitEndOfFile,
    truncatedByBudget,
    truncated: truncatedByBudget || truncatedByRange,
  };
}
