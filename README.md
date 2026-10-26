# Context Weaver

Context Weaver is a repo-native FileBlock context compiler for coding agents. It
turns rules, skills, Handbook meaning, source/AST evidence, cache state, and
runtime audit evidence into bounded SQLite projections exposed through `ctx`.

Use it when raw `rg` or `find` hits are not enough. A string match can tell an
agent where text appears, but it cannot tell which owner, rule, cache partition,
or proof gate applies. Context Weaver gives the agent a project coordinate
system before it edits code or makes architecture claims.

The product surface is one Unix-like `target.method(payload)` CLI. The seven
first-level targets are `help`, `sql`, `cache`, `rule`, `skill`, `handbook`, and
`codebase`; the four semantic targets remain independent and cross-module
composition is performed by a caller through four separate calls.

Relation-facing results preserve the same object contract used by parsers,
owners, cache, and SQL: projected nodes are `{name,structure,behavior}` and
projected relations are `{frompath,topath}`. They are derived from FileBlock
JSONB; `ctx codebase slice` source reads are explicit `FileExcerpt` observations.

## Start here

The product usage guide is the main entry for users:

```text
docs/user-guide.md
```

Typical first commands:

```bash
ctx help --full
ctx cache status
ctx codebase search context
ctx sql "SELECT json_extract(structure, '$.kind') AS kind, COUNT(*) AS c FROM nodes GROUP BY kind ORDER BY c DESC" --json
ctx skill list
```

Add `--json` when a caller needs machine-readable output.

## Current product surface

Context Weaver currently ships these user-facing surfaces:

- `ctx help` for the public target.method catalog
- `ctx sql` for direct read-only queries over FileBlock projections and `token_weight`
- `ctx cache status/build/clear` for persistent cache management
- `ctx rule`, `ctx skill`, `ctx handbook`, and `ctx codebase <operation>` for four independent services

Architecture truth lives in `handbook/README.md` and the Obsidian Markdown notes under `handbook/`. Usage guidance lives in `docs/user-guide.md`; the public change projection is `CHANGELOG.md`. Execution plans live in `docs/plan/*.md`.
