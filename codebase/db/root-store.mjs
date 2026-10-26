import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ErrorObject } from '../../common/lib/error-object.mjs';
import { normalizeRoot } from '../../common/lib/normalize-root.mjs';
import { sha256Text } from '../../common/lib/source-fingerprint.mjs';

const HASH_PREFIX_LENGTH = 12;

export class RootStore {
  #baseDir;

  constructor({ baseDir }) {
    this.#baseDir = baseDir;
  }

  // paths.cacheDir is the root of the per-root caches (ADR-007).
  static resolveDbPath({ config, root }) {
    if (!config?.paths?.cacheDir) {
      throw new ErrorObject({ code: 'CACHE_CONFIG_MISSING', message: 'Cache configuration is missing paths.cacheDir.' });
    }
    return new RootStore({ baseDir: config.paths.cacheDir }).open({ root }).dbPath;
  }

  resolve({ root }) {
    const normalized = normalizeRoot(root);
    const hash = sha256Text(normalized).slice(0, HASH_PREFIX_LENGTH);
    const dir = path.join(this.#baseDir, hash);
    return {
      dir,
      dbPath: path.join(dir, 'cache.db'),
      metaPath: path.join(dir, 'meta.json'),
      root: normalized,
      hash,
    };
  }

  open({ root }) {
    const resolved = this.resolve({ root });
    mkdirSync(resolved.dir, { recursive: true });
    if (!existsSync(resolved.metaPath)) {
      writeFileSync(resolved.metaPath, JSON.stringify({
        root: resolved.root,
        hash: resolved.hash,
        created: new Date().toISOString(),
      }, null, 2));
    }
    return resolved;
  }
}

// paths.cacheDir is the root of the per-root caches (ADR-007).
export function resolveDbPath(payload) {
  return RootStore.resolveDbPath(payload);
}
