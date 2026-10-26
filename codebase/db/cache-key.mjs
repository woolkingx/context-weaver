import { normalizeRoot } from '../../common/lib/normalize-root.mjs';

export function cacheKeyFor(owner, root) {
  return `${owner}:${normalizeRoot(root)}`;
}
