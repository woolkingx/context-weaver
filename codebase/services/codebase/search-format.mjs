// Compact text form of a SearchResult: one line per hit, ripgrep style.
export function formatSearchResult(result) {
  if (!result || result.object !== 'SearchResult') return null;
  const files = new Set(result.hits.map((hit) => hit.path)).size;
  const scope = result.path ? ` under ${result.path}` : '';
  const lines = [`search "${result.query}"${scope}: ${result.hits.length} hit(s) in ${files} file(s)`];
  for (const hit of result.hits) lines.push(`${hit.path}:${hit.line}:${hit.column}  ${hit.text.trim()}`);
  if (result.hits.length === 0) lines.push('(no hits)');
  if (result.truncated) lines.push(`(more hits exist; raise --limit above ${result.limit} or narrow with --path)`);
  return `${lines.join('\n')}\n`;
}
