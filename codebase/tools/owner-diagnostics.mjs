import { cacheKeyFor } from '../db/cache-key.mjs';

export function ownerErrors({ admissionErrors = new Map(), loadErrors = new Map() }) {
  return [...new Map([...admissionErrors, ...loadErrors])].map(([owner, error]) => ({
    owner,
    error: errorFields(error),
  }));
}

export function markIncompatibleOwner({
  fileBlockStore, owner, root, error,
}) {
  const mark = error?.context?.fileMark;
  if (!fileBlockStore || mark?.status !== 'incompatible' || !Array.isArray(mark.paths)) return;
  fileBlockStore.publication.markIncompatible({
    owner,
    cacheKey: cacheKeyFor(owner, root),
    rootId: root,
    files: mark.paths,
    error,
  });
}

export function incompatibleStatus({
  owner, root, fileBlockStore, error,
}) {
  const cacheKey = cacheKeyFor(owner, root);
  const files = fileBlockStore.ledger.incompatible({ owner, cacheKey });
  return {
    owner,
    cache_key: cacheKey,
    state: 'incompatible',
    incompatible: true,
    file_count: 0,
    incompatible_file_count: files.length,
    files,
    error: errorFields(error),
    recovery: error.context?.fileMark?.action ?? 'Correct the Handbook layout, then rerun ctx cache status.',
  };
}

function errorFields(error) {
  const context = error?.context && typeof error.context === 'object'
    ? Object.fromEntries(Object.entries(error.context).filter(([key]) => key !== 'stack' && key !== 'cause'))
    : null;
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    message: error?.message ?? String(error),
    ...(context && Object.keys(context).length > 0 ? { context } : {}),
  };
}
