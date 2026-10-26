// Addressing helpers shared by the Canonical Store targets.

export function fileAddress(rootId, filePath) {
  return `${rootId}\0${filePath}`;
}

// SQL scope of one owner, or of one owner/cache partition when cacheKey is given.
export function ownerScope({ owner, cacheKey = null }) {
  return cacheKey === null
    ? { where: 'owner = ?', params: [owner] }
    : { where: 'owner = ? AND cache_key = ?', params: [owner, cacheKey] };
}
