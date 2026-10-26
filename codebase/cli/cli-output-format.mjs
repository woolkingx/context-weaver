import { GraphFlowFormatter } from '../services/codebase/graph/graph-format.mjs';
import { formatSearchResult } from '../services/codebase/search-format.mjs';
import { MarkdownRenderer } from '../projection/markdown-renderer.mjs';

export function cleanContentMarkdown(obj) {
  return MarkdownRenderer.cleanContent(obj);
}

export function compactHumanOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value.object === 'GraphFlow') return compactGraphFlow(value);
  if (value.object === 'SearchResult') return formatSearchResult(value);
  if (value.world?.object === 'WorldMap') return compactWorldResult(value);
  return compactObject(value);
}

function compactGraphFlow(value) {
  return GraphFlowFormatter.format(value) ?? compactObject(value);
}

function compactWorldResult(value) {
  const keys = ['object', 'status', 'query', 'root', 'view', 'depth', 'proof_boundary', 'display_graph', 'world', 'next'];
  return Object.fromEntries(keys
    .filter((key) => Object.hasOwn(value, key))
    .map((key) => [key, compactWorldValue(value[key])]));
}

function compactWorldValue(value) {
  if (Array.isArray(value)) return value.map((item) => compactWorldValue(item));
  if (value && typeof value === 'object') return compactObject(value);
  return value;
}

function compactObject(value) {
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'structure') {
      output[key] = compactStructure(parseJsonObject(entry));
    } else if (key === 'behavior') {
      output[key] = compactBehavior(parseJsonObject(entry));
    } else if (['content', 'excerpt', 'text'].includes(key) && typeof entry === 'string') {
      output[key] = shorten(entry, 320);
    } else if (Array.isArray(entry)) {
      output[key] = entry.map((item) => (item && typeof item === 'object' ? compactObject(item) : item));
    } else if (entry && typeof entry === 'object') {
      output[key] = compactObject(entry);
    } else {
      output[key] = entry;
    }
  }
  return output;
}

function compactStructure(structure) {
  if (!structure || typeof structure !== 'object' || Array.isArray(structure)) {
    return typeof structure === 'string' ? shorten(structure, 320) : structure;
  }
  const output = {};
  for (const [key, value] of Object.entries(structure)) {
    if (['kind', 'displayName', 'path', 'line', 'scope', 'root', 'count'].includes(key)) {
      output[key] = value;
    } else if (['content', 'excerpt'].includes(key) && typeof value === 'string') {
      output[key] = shorten(value, 320);
    } else if (Array.isArray(value) || value && typeof value === 'object') {
      output[`${key}_count`] = Array.isArray(value) ? value.length : Object.keys(value).length;
    }
  }
  return output;
}

function compactBehavior(behavior) {
  if (!behavior || typeof behavior !== 'object' || Array.isArray(behavior)) return behavior;
  const output = {};
  for (const [key, value] of Object.entries(behavior)) {
    if (Array.isArray(value) || value && typeof value === 'object') {
      output[`${key}_count`] = Array.isArray(value) ? value.length : Object.keys(value).length;
    } else {
      output[key] = value;
    }
  }
  return output;
}

function parseJsonObject(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function shorten(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
