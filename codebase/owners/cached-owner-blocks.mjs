import { withCacheFoundation } from '../db/cache-foundation.mjs';

// The semantic owner remains the producer. This helper only exposes the
// canonical FileBlocks admitted and revalidated by Cache Foundation.
export async function loadCachedOwnerBlocks(owner, root, fileBlockStore, cacheSession = null) {
  if (cacheSession) return cacheSession.load({ owner, root });
  if (!fileBlockStore) return null;
  return withCacheFoundation({
    root,
    fileBlockStore,
    callback: (_store, session) => session.load({ owner, root }),
  });
}
