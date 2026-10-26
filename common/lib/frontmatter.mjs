// Common frontmatter parser. It deliberately handles the small YAML subset
// used by skill metadata, including folded and literal block scalars.
export function parseFrontmatter(content) {
  const match = String(content ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const metadata = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const pair = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;
    const [, key, raw] = pair;
    if (['|', '>', '|-', '>-'].includes(raw)) {
      const block = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        block.push(lines[++index].trim());
      }
      metadata[key] = block.join(' ').trim();
      continue;
    }
    metadata[key] = raw.replace(/^['"]|['"]$/g, '');
  }
  return metadata;
}

export function extractHeader(content) {
  if (content == null) return null;
  const frontmatter = parseFrontmatter(content);
  if (Object.keys(frontmatter).length > 0) return frontmatter;
  const heading = String(content).split(/\r?\n/).find((line) => line.startsWith('# '));
  return { name: '', description: heading ? heading.replace(/^#\s+/, '') : '' };
}
