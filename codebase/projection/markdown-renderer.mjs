import json2md from 'json2md';
import { MarkdownProjector } from './markdown-projector.mjs';

export class MarkdownRenderer {
  static renderTokens(tokens) {
    const output = json2md(tokens);
    return `${String(output).trim()}\n`;
  }

  static renderDocument(value) {
    if (typeof value === 'string') return value;
    return this.renderTokens(MarkdownProjector.project(value));
  }

  static stripMarkdownMeta(text) {
    return String(text ?? '')
      .replace(/^---[\s\S]*?---\n?/m, '')
      .replace(/^```[\s\S]*?```\n?/gm, '')
      .replace(/^```.*$/gm, '')
      .replace(/^(\|[^\n]+\|\n?)+/gm, '')
      .replace(/^\|.+\|$/gm, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')
      .replace(/^[ \t]+[^\n]{1,40}$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  static cleanContent(obj) {
    if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map((item) => MarkdownRenderer.cleanContent(item));
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = (k === 'content' && typeof v === 'string')
        ? MarkdownRenderer.stripMarkdownMeta(v)
        : MarkdownRenderer.cleanContent(v);
    }
    return out;
  }
}

export function renderMarkdown(tokens) {
  return MarkdownRenderer.renderTokens(tokens);
}
