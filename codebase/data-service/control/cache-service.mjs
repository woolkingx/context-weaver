import { DEFAULT_CACHE_OWNERS } from '../../../common/tools/tools.schema.mjs';

export class CacheService {
  constructor({ runtime }) {
    this.runtime = runtime;
  }

  async status({ root, owners }) {
    const resolved = owners ?? [...DEFAULT_CACHE_OWNERS];
    this.runtime.assertValidProjectRoot(root);
    this.runtime.startCommand({ root, owners: resolved });
    const rows = await this.runtime.toolsApi.cacheStatus({
      root,
      owners: resolved,
      config: this.runtime.getConfig(root),
    });
    return { object: 'CacheStatus', summary: { owners: rows.length }, owners: rows };
  }

  async build({ root, owners }) {
    const resolved = owners ?? [...DEFAULT_CACHE_OWNERS];
    this.runtime.assertValidProjectRoot(root);
    this.runtime.startCommand({ root, owners: resolved });
    const result = await this.runtime.toolsApi.cacheBuild({
      root,
      owners: resolved,
      config: this.runtime.getConfig(root),
    });
    return { object: 'CacheBuild', owners: resolved, ...result };
  }

  async clear({ root, owners }) {
    const resolved = owners ?? [...DEFAULT_CACHE_OWNERS];
    this.runtime.assertValidProjectRoot(root);
    this.runtime.startCommand({ root, owners: resolved });
    const cleared = await this.runtime.toolsApi.cacheClear({
      root,
      owners: resolved,
      config: this.runtime.getConfig(root),
    });
    return { object: 'CacheClear', ...cleared };
  }
}
