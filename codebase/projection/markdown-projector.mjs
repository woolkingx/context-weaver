const MAX_LIST_ITEMS = 12;
const MAX_TEXT_LENGTH = 360;

const TITLES = Object.freeze({
  CacheBuild: 'Cache Build',
  CacheClear: 'Cache Clear',
  CacheStatus: 'Cache Status',
  EvidenceResult: 'Evidence',
  ExplainResult: 'Explain Result',
  FileExcerpt: 'File Excerpt',
  HandbookExport: 'Handbook Export',
  HandbookResult: 'Handbook Result',
  HandbookStats: 'Handbook Stats',
  HandbookTree: 'Handbook Tree',
  ModuleStatus: 'Module Status',
  ProjectCoordinate: 'Project Coordinate',
  RelationProjection: 'Relation Projection',
  SensorReport: 'Sensor Report',
  SqlResult: 'SQL Result',
  WorldMap: 'World Map',
});

const SUMMARY_FIELDS = Object.freeze([
  'status', 'query', 'root', 'command', 'view', 'depth', 'path', 'source', 'owner',
  'rowCount', 'count', 'complete', 'completeness', 'resultState', 'truncated',
]);

export class MarkdownProjector {
  static MAX_LIST_ITEMS = MAX_LIST_ITEMS;

  static MAX_TEXT_LENGTH = MAX_TEXT_LENGTH;

  static project(value) {
    if (value === null || value === undefined) return [{ p: 'No result.' }];
    if (typeof value !== 'object') return [{ p: String(value) }];
    if (Array.isArray(value)) return [{ ul: value.slice(0, MAX_LIST_ITEMS).map(MarkdownProjector.itemLabel) }];

    const tokens = [{ h1: MarkdownProjector.titleFor(value.object) }];
    const skipSummaryFields = typeof value.object === 'string' && value.object.startsWith('Handbook');
    if (!skipSummaryFields) {
      MarkdownProjector.#addFacts(tokens, value, SUMMARY_FIELDS);
    }

    if (value.world?.object === 'WorldMap') MarkdownProjector.#projectWorldMap(tokens, value.world);
    if (value.object === 'WorldMap') MarkdownProjector.#projectWorldMap(tokens, value);
    if (value.object === 'SensorReport') MarkdownProjector.#projectSensorReport(tokens, value);
    if (value.object === 'FileExcerpt') MarkdownProjector.#projectExcerpt(tokens, value);
    if (value.object === 'SqlResult' || value.object === 'EvidenceResult') MarkdownProjector.#projectRows(tokens, value);
    if (value.object === 'RelationProjection') MarkdownProjector.#projectRelations(tokens, value);
    if (value.object === 'ModuleStatus') MarkdownProjector.#projectModuleStatus(tokens, value);
    if (value.object === 'ExplainResult') MarkdownProjector.#projectExplainResult(tokens, value);
    if (value.object === 'ProjectCoordinate') MarkdownProjector.#projectProjectCoordinate(tokens, value);
    if (typeof value.object === 'string' && value.object.startsWith('Handbook')) MarkdownProjector.#projectHandbook(tokens, value);

    MarkdownProjector.#projectNext(tokens, value.next);
    if (tokens.length === 1) MarkdownProjector.#projectGenericFields(tokens, value);
    return tokens;
  }

  static #projectSensorReport(tokens, value) {
    MarkdownProjector.#addItems(tokens, 'Results', value.results, (result) => {
      const ruleRefs = result.metadata?.ruleRefs ?? [];
      const label = [
        result.route,
        MarkdownProjector.sourceLabel(result.source),
        MarkdownProjector.locationLabel(result.location),
        ruleRefs.length > 0 ? `rules: ${ruleRefs.join(', ')}` : null,
      ].filter(Boolean).join(' · ');
      return label || MarkdownProjector.itemLabel(result);
    });
    for (const result of (value.results ?? []).slice(0, MAX_LIST_ITEMS)) {
      const excerpt = result.excerpt ?? result.text;
      if (excerpt) {
        MarkdownProjector.#addCode(tokens, MarkdownProjector.locationLabel(result.location), excerpt, MarkdownProjector.languageForPath(result.location?.path));
      }
    }
  }

  static #projectExcerpt(tokens, value) {
    const label = [value.path, MarkdownProjector.lineRange(value.start_line, value.end_line)].filter(Boolean).join(':');
    if (label) tokens.push({ h2: label });
    if (value.text) MarkdownProjector.#addCode(tokens, label || 'Excerpt', value.text, MarkdownProjector.languageForPath(value.path));
  }

  static #projectRows(tokens, value) {
    const rows = value.rows ?? value.evidence ?? [];
    MarkdownProjector.#addFacts(tokens, value, ['rowCount']);
    MarkdownProjector.#addItems(tokens, 'Rows', rows, MarkdownProjector.rowItem);
  }

  static #projectRelations(tokens, value) {
    MarkdownProjector.#addFacts(tokens, value, ['query']);
    MarkdownProjector.#addItems(tokens, 'Nodes', value.nodes, MarkdownProjector.nodeItem);
    MarkdownProjector.#addItems(tokens, 'Edges', value.edges, MarkdownProjector.relationItem);
  }

  static #projectModuleStatus(tokens, value) {
    if (value.message) tokens.push({ h2: 'Status' }, { p: value.message });
    if (value.next) MarkdownProjector.#addItems(tokens, 'Next', value.next, MarkdownProjector.itemLabel);
  }

  static #projectExplainResult(tokens, value) {
    MarkdownProjector.#addFacts(tokens, value, ['target']);
    const excerpts = value.evidence?.source ?? value.source ?? [];
    MarkdownProjector.#addItems(tokens, 'Evidence', excerpts, MarkdownProjector.evidenceItem);
    for (const excerpt of excerpts.slice(0, MAX_LIST_ITEMS)) {
      if (excerpt.excerpt) {
        MarkdownProjector.#addCode(tokens, MarkdownProjector.locationLabel(excerpt.location), excerpt.excerpt, MarkdownProjector.languageForPath(excerpt.location?.path));
      }
    }
  }

  static #projectProjectCoordinate(tokens, value) {
    if (!value.owners || typeof value.owners !== 'object') return;
    tokens.push({ h2: 'Owners' });
    tokens.push({ ul: Object.entries(value.owners).map(([owner, details]) => `${MarkdownProjector.humanize(owner)}: ${MarkdownProjector.summaryValue(details)}`) });
  }

  static #projectHandbook(tokens, value) {
    if (value.object === 'HandbookTree') {
      MarkdownProjector.#addFacts(tokens, value, ['start', 'depth']);
      MarkdownProjector.#addItems(tokens, 'Nodes', value.nodes ?? [], MarkdownProjector.nodeItem);
      return;
    }
    MarkdownProjector.#addFacts(tokens, value, ['start', 'depth']);
    if (value.count !== undefined) {
      tokens.push({ ul: [`<strong>Count</strong>: ${value.count}`] });
    }
    const hasSelection = value.selection && (value.selection.chapter || value.selection.tags?.length || value.selection.ids?.length);
    if (!hasSelection && value.count === 0) {
      tokens.push({ p: '⚠️ No blocks matched the query. Use --chapter, --tags, or --ids to select specific blocks.' });
    } else if (!hasSelection) {
      tokens.push({ p: 'ℹ️ Showing all blocks. Use --chapter, --tags, or --ids to filter.' });
    }
    MarkdownProjector.#addItems(tokens, 'Blocks', value.blocks ?? value.nodes, (block) => block.title ?? block.id ?? MarkdownProjector.itemLabel(block));
    MarkdownProjector.#addItems(tokens, 'Relations', value.relations, MarkdownProjector.relationItem);
    if (value.contentRefs && typeof value.contentRefs === 'object') {
      MarkdownProjector.#addItems(tokens, 'Content', Object.entries(value.contentRefs), ([id, content]) => `${id}: ${MarkdownProjector.shorten(content)}`);
    }
  }

  static #projectWorldMap(tokens, world) {
    tokens.push({ h2: 'World Map' });
    const evidence = world.evidence ?? {};
    MarkdownProjector.#addFacts(tokens, evidence, ['canonical', 'projection', 'query', 'query_text', 'command', 'query_lane', 'matched', 'truncated']);
    if (Array.isArray(world.route)) tokens.push({ p: `<strong>Route</strong>: ${world.route.join(' → ')}` });
    MarkdownProjector.#addFacts(tokens, evidence, ['node_count', 'edge_count', 'returned_node_count', 'returned_edge_count']);
    MarkdownProjector.#addItems(tokens, 'Focus', world.focus, MarkdownProjector.nodeItem);
    MarkdownProjector.#addItems(tokens, 'Nodes', world.nodes, MarkdownProjector.nodeItem);
    MarkdownProjector.#addItems(tokens, 'Edges', world.edges, MarkdownProjector.relationItem);
  }

  static #projectNext(tokens, next) {
    if (!Array.isArray(next) || next.length === 0) return;
    MarkdownProjector.#addItems(tokens, 'Next', next, (item) => {
      if (item?.label && item.command) return `${item.label}: \`${item.command}\``;
      return MarkdownProjector.itemLabel(item);
    });
  }

  static #addItems(tokens, heading, items, formatter) {
    if (!Array.isArray(items) || items.length === 0) return;
    const shown = items.slice(0, MAX_LIST_ITEMS).map(formatter).filter(Boolean);
    if (shown.length === 0) return;
    const omitted = items.length - shown.length;
    if (omitted > 0) shown.push(`… ${omitted} more`);
    tokens.push({ h2: heading });
    tokens.push({ ul: shown });
  }

  static #addFacts(tokens, value, fields) {
    const facts = fields
      .filter((field) => value?.[field] !== undefined && value[field] !== null)
      .map((field) => `<strong>${MarkdownProjector.humanize(field)}</strong>: ${field === 'query' ? MarkdownProjector.queryLabel(value[field]) : MarkdownProjector.summaryValue(value[field])}`);
    if (facts.length > 0) tokens.push({ ul: facts });
  }

  static #projectGenericFields(tokens, value) {
    const fields = Object.entries(value)
      .filter(([key]) => key !== 'object')
      .slice(0, MAX_LIST_ITEMS)
      .map(([key, entry]) => `<strong>${MarkdownProjector.humanize(key)}</strong>: ${MarkdownProjector.summaryValue(entry)}`);
    if (fields.length > 0) tokens.push({ h2: 'Details' }, { ul: fields });
  }

  static #addCode(tokens, heading, content, language = '') {
    const text = MarkdownProjector.shorten(String(content ?? ''), MAX_TEXT_LENGTH);
    if (!text) return;
    tokens.push({ h3: heading || 'Source' }, { code: { language, content: text } });
  }

  static titleFor(object) {
    return TITLES[object] ?? MarkdownProjector.humanize(object ?? 'Context result');
  }

  static nodeItem(node) {
    if (!node || typeof node !== 'object') return MarkdownProjector.itemLabel(node);
    const name = node.name ?? node.id ?? node.title;
    const kind = node.type ?? node.kind ?? node.structure?.kind;
    const path = node.path ?? node.structure?.path;
    return [name, kind, path].filter(Boolean).join(' · ') || MarkdownProjector.itemLabel(node);
  }

  static relationItem(edge) {
    if (!edge || typeof edge !== 'object') return MarkdownProjector.itemLabel(edge);
    const from = edge.sourceId ?? edge.from ?? edge.fromnode ?? edge.frompath;
    const to = edge.targetId ?? edge.to ?? edge.tonode ?? edge.topath;
    const relation = edge.type ?? edge.rel ?? edge.kind ?? edge.relation_kind ?? 'related';
    return [from, relation, to].filter(Boolean).join(' → ') || MarkdownProjector.itemLabel(edge);
  }

  static evidenceItem(item) {
    if (!item || typeof item !== 'object') return MarkdownProjector.itemLabel(item);
    return [item.route, item.location?.path, MarkdownProjector.lineRange(item.location?.startLine, item.location?.endLine), item.score]
      .filter((entry) => entry !== undefined && entry !== null && entry !== '')
      .join(' · ') || MarkdownProjector.itemLabel(item);
  }

  static rowItem(row) {
    if (!row || typeof row !== 'object') return MarkdownProjector.itemLabel(row);
    return [row.name, row.path, row.kind, row.status].filter(Boolean).join(' · ') || MarkdownProjector.itemLabel(row);
  }

  static itemLabel(value) {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'object') return MarkdownProjector.shorten(String(value));
    return Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined && typeof entry !== 'object')
      .slice(0, 4)
      .map(([key, entry]) => `${MarkdownProjector.humanize(key)}=${entry}`)
      .join(', ') || `${Object.keys(value).length} fields`;
  }

  static queryLabel(query) {
    if (!query || typeof query !== 'object') return MarkdownProjector.summaryValue(query);
    return query.query ?? query.text ?? query.path ?? query.intent ?? MarkdownProjector.itemLabel(query);
  }

  static sourceLabel(source) {
    if (!source || typeof source !== 'object') return source;
    return source.path ?? source.owner ?? source.tool ?? MarkdownProjector.itemLabel(source);
  }

  static summaryValue(value) {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'string') return MarkdownProjector.shorten(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
    return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? '' : 's'}`;
  }

  static humanize(value) {
    return String(value ?? '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  static lineRange(start, end) {
    if (start === undefined || start === null) return '';
    return end && end !== start ? `L${start}-L${end}` : `L${start}`;
  }

  static locationLabel(location) {
    if (!location) return '';
    return [location.path, MarkdownProjector.lineRange(location.startLine, location.endLine)].filter(Boolean).join(':');
  }

  static languageForPath(path) {
    const extension = String(path ?? '').split('.').pop()?.toLowerCase();
    return {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', json: 'json', md: 'markdown',
    }[extension] ?? '';
  }

  static shorten(value, limit = MAX_TEXT_LENGTH) {
    const text = String(value ?? '');
    return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
  }
}
