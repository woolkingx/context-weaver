/**
 * Common evidence envelope for frontends that currently expose symbols or a
 * text dump rather than a lossless language AST. It is intentionally marked
 * partial so consumers never confuse source-line evidence with syntax facts.
 */
export function partialAst(source, { language, parser_version, rootKind = 'TranslationUnit' } = {}) {
  const text = String(source);
  const lines = text.split(/\r?\n/);
  let offset = 0;
  return {
    format: 'ctx.ast.v1',
    language,
    parser_version,
    completeness: 'partial',
    offset_encoding: 'utf16-code-unit',
    source_text: text,
    source_length: text.length,
    root: {
      kind: rootKind,
      ordinal: 0,
      field: null,
      start: 0,
      end: text.length,
      line: 1,
      column: 1,
      children: lines.map((lineText, index) => {
        const start = offset;
        const end = start + lineText.length;
        offset = end + 1;
        return {
          kind: 'SourceLine',
          ordinal: index,
          line: index + 1,
          column: 1,
          start,
          end,
          text: lineText,
          children: [],
        };
      }),
    },
  };
}
