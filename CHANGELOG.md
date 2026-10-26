# Changelog

This file projects changes for repository readers. The canonical project purpose and architecture remain in [the Handbook](handbook/README.md); this file does not define them. Entries under Unreleased describe worktree changes, not a published release.

## 0.2.0 — 2026-10-26

- **Handbook Dual-Format Doc-Cache**: `HandbookStore` (`codebase/handbook/unit-block-store.mjs`) encapsulates dual-format parsing for both Obsidian Markdown notes and legacy XML unit blocks into standard JSONB FileBlocks. Handbook documents enter doc-cache for real-time SQL full-text search and are detached from SQLite `node_rows`/`edge_rows` relational projections (ADR-009).
- **Dead Code and Compatibility Shims Elimination**: Quarantined unused abstractions and dead files to `.trash/` (`common/parsers/index.mjs`, `codebase/sensors/ast-roles.mjs`, `codebase/projection/json2md.mjs`, `codebase/lib/schema-registry.mjs`, `codebase/owners/object-owner.mjs`, `codebase/owners/file-cache-pairs.mjs`). Removed 20+ legacy procedural aliases in `token-budget.mjs` and 7 legacy wrappers in `skill-paths.mjs` (ADR-010).
- **Direct Domain Class Architecture**: Streamlined to clean domain classes (`TokenBudgetTrimmer`, `LayeredGraphLayout`, `DisplayGraph`, `HandbookStore`, `SkillPathResolver`, `PERSISTENT_OWNER_DEFINITIONS`) with strict `Target.Method(Payload)` signatures.
- **Dogfooding & Self-Inspection**: Used `ctx` graph queries (`ctx sql`, `ctx codebase dep`, `ctx cache status`) to verify zero circular dependencies, validate dependency flow, and enforce clean architecture boundaries across 164 admitted files.
- **Multi-lingual Native AST Parsers**: Hardened native AST producers (`js.mjs`, `clang.mjs`, `rust.mjs`, `python.mjs`) to uniform object payload interfaces.
- **Testing & Gates**: 27/27 public contract tests passing; all 6 architecture gates green; ESLint 0 errors, 0 warnings.

## 0.1.0 — 2026-09-24

<worktree id="handbook-and-proof-alignment" owner="master" boundary="uncommitted-unpublished">
The Handbook index moved to `handbook/README.md`, with its loader, documentation pointers, sample fixture, and tests aligned to that location. The Handbook evidence-testing block now distinguishes development correctness from release CLI usability. Development proof runs the classified unit, contract, and integration tests; release proof runs one bounded CLI journey matrix with a terminal receipt and timeout failure path. These changes are present in the master worktree; this entry does not claim that they were committed, synchronized, or published.
</worktree>
