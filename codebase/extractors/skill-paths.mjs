import path from 'node:path';

import { ConfigOwner } from '../../common/config/config-loader.mjs';

export class SkillPathResolver {
  static toPosix(value) {
    return String(value).split(path.sep).join('/');
  }

  static normalizeRelativePath(value) {
    return this.toPosix(String(value || '')).replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  }

  static normalizeGlobalSkillSource(rawSource, sourceIndex = 0) {
    const absolutePath = path.resolve(rawSource.absolutePath ?? '');
    const pathPrefix = this.normalizeRelativePath(
      rawSource.pathPrefix ?? `global:${absolutePath}`,
    );
    return {
      absolutePath,
      pathPrefix,
      scope: rawSource.scope ?? 'global',
      sourceIndex,
    };
  }

  static normalizeGlobalSkillSources(sources) {
    return sources
      .filter((entry) => entry && typeof entry.absolutePath === 'string' && entry.absolutePath.length > 0)
      .map((entry, index) => this.normalizeGlobalSkillSource(entry, index));
  }

  static getConfiguredGlobalSkillSources(projectRoot = process.cwd()) {
    const configured = new ConfigOwner().resolve({ root: projectRoot }).values.globalSkillRoots ?? [];
    return configured
      .filter((entry) => entry && typeof entry.absolutePath === 'string' && entry.absolutePath.length > 0)
      .map((entry, index) => this.normalizeGlobalSkillSource(entry, index));
  }

  static getProjectSkillSource(projectRoot) {
    const repoRoot = path.resolve(projectRoot ?? process.cwd());
    return {
      absolutePath: path.join(repoRoot, '.claude', 'skills'),
      pathPrefix: '.claude/skills',
      scope: 'project',
      sourceIndex: -1,
    };
  }

  static getSkillSources(projectRoot) {
    return [this.getProjectSkillSource(projectRoot), ...this.getConfiguredGlobalSkillSources(projectRoot)];
  }

  static buildSkillPath(source, relativePath) {
    const normalizedRelative = this.normalizeRelativePath(relativePath);
    return normalizedRelative ? `${source.pathPrefix}/${normalizedRelative}` : source.pathPrefix;
  }

  static resolveSkillPathToLocation(skillPath, projectRoot, { globalSkillSources = null } = {}) {
    const requestedPath = this.normalizeRelativePath(skillPath ?? '');
    if (!requestedPath) {
      return null;
    }

    const globalSources = this.normalizeGlobalSkillSources(
      globalSkillSources ?? this.getConfiguredGlobalSkillSources(projectRoot),
    );
    const match = globalSources.find((source) => (
      requestedPath === source.pathPrefix || requestedPath.startsWith(`${source.pathPrefix}/`)
    ));

    if (match) {
      const suffix = requestedPath === match.pathPrefix
        ? ''
        : requestedPath.slice(match.pathPrefix.length + 1);
      return {
        absoluteRoot: match.absolutePath,
        relativePath: suffix,
        scope: match.scope,
        sourceType: 'global',
        pathPrefix: match.pathPrefix,
        path: requestedPath,
      };
    }

    if (requestedPath.startsWith('global:')) {
      return null;
    }

    return {
      absoluteRoot: path.resolve(projectRoot ?? process.cwd()),
      relativePath: requestedPath,
      scope: 'project',
      sourceType: 'project',
      pathPrefix: 'project',
      path: requestedPath,
    };
  }

  static resolveGlobalSkillLocation(skillPath, projectRoot, options) {
    const location = this.resolveSkillPathToLocation(skillPath, projectRoot, options);
    return location?.sourceType === 'global' ? location : null;
  }

  static resolveSkillAbsolutePath(skillPath, projectRoot) {
    const location = this.resolveSkillPathToLocation(skillPath, projectRoot);
    if (!location) return null;
    if (!location.relativePath) return location.absoluteRoot;
    return path.resolve(location.absoluteRoot, location.relativePath);
  }
}
