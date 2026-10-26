---
tags: [handbook, architecture, modules]
description: "What each semantic service and control entry owns, what it excludes, what it exposes, and how they are wired together."
version: 8
---

# Modules

## What

Context Weaver has four semantic source modules. Each admits its source through `FileOwner` and builds complete file-level FileBlock JSONB. The persistent cache accelerates Codebase only; the other three are rebuilt for each request in memory. The cache is not a fifth semantic owner.

```text
Rule ───────┐
Skill ──────┤
Handbook ───┼─> FileOwner -> FileBlock JSONB -> SQL projections -> Tools API
Codebase ───┘                    └─ complete AST value for source files
```

Runtime schema, CLI, the tools catalog, plans, dirtree, SQL, and cache are support responsibilities or projections. They do not create semantic owner rows.

## Rule

**Owns** project and global `AGENTS.md` constraints.

**Excludes** skill procedures and handbook meaning. A rule states a binding constraint, invariant, permission, or prohibition; it does not describe a repeatable procedure and does not own architecture reasoning.

**Exposes** `codebase/services/rule/rule-service.mjs`. The public method is `run`, which returns a `RuleResult` block carrying the rule rows and the cache provenance; it delegates to `queryRules`, which asks the Unified Data Service for the projection rather than reading storage itself.

**Admission** uses the same `FileOwner` path as every other owner. Rule may name additional global roots, each admitted separately.

## Skill

**Owns** project and configured global `SKILL.md` procedures.

**Excludes** constraints and product truth. A skill owns reusable how and when; it may not override a governing rule or silently decide product truth.

**Exposes** `codebase/services/skill/skill-service.mjs` with three operations over `.claude/skills/<name>/SKILL.md`: `query` ranks by keyword and lists the skill directory tree, `load` returns the `SKILL.md` body with references and sub-skills as headers — named `into` items load in full — and `list` returns the skill directory tree. Results are `SkillReport` blocks produced by `codebase/services/skill/skill-implementation.mjs`, and each call runs inside a projection session scoped to the `skills` owner.

**Relation** Skill follows the agent route in [[handbook/routing]]: the handbook route selects which skill is primary, and the selected skill owns the procedure.

## Handbook

**Owns** product and architecture truth: purpose, object meanings, owner boundaries, legal relations, lifecycle, operations, proof, and evolution. It is the notes in this directory, indexed by `handbook/README.md`.

**Excludes** reusable how. Procedures live in skills and references; execution order lives in plans; evidence lives in verification records. The handbook states what is true and who owns it, not how to perform a task.

**Exposes** `codebase/services/handbook/handbook-service.mjs` with the single method `read`, which is currently in maintenance status for public CLI queries while notes are read directly. Ingestion into document cache is active through `HandbookStore` (`codebase/handbook/unit-block-store.mjs`), which parses dual-format (`ob` Markdown and `xml` unit blocks) into `handbook_block` JSONB FileBlocks. Under ADR-008 and ADR-009, handbook blocks are retained in doc-cache for full-text search and are detached from persistent relational SQL tables (`node_rows`, `edge_rows`).

**Status** direct Markdown readback is the canonical truth. Document cache ingestion is verified across all handbook notes, while public `ctx handbook` CLI routing remains a maintenance endpoint. See [[handbook/README]] and ADR-009 in [[handbook/decisions]].

## Codebase

**Owns** admitted implementation files, parser evidence, and complete ASTs. It owns the official language frontend and the AST-to-JSONB evidence contract.

**Excludes** the other three owners' content. It does not interpret rules, load skills, or restate handbook meaning.

**Exposes** nine Codebase-local methods through `codebase/services/codebase/codebase-service.mjs`: `relate`, `token`, `search`, `slice`, `contain`, `call`, `dep`, `data`, and `seq`. `relate` returns Codebase-local co-occurrence and AST relations, `token` is CRUD over the Codebase token matrix, `search` finds where a string occurs in admitted source by a real-time SQL filter over the persisted FileBlocks, and `slice` reads source lines. `contain`, `call`, `dep`, `data`, and `seq` are the five graph views of a symbol or file over `node_rows` and `edge_rows`; they belong to the Codebase module, not to a separate service, so there is no `graph` or `slice` target. Methods are reachable only below the `codebase` target; there is no global `find`, `grep`, or `eval` route.

## Unified Data Service

**Owns** the three shared data capabilities: `file` admission and FileBlock publication, `sql` read-only projection, and `cache` freshness and lifecycle. It is the integration point for FileBlock loading, SQL, cache lifecycle, and Handbook data projection.

**Exposes** `codebase/data-service/unified-data-service.mjs`, which composes `ToolsApi` and coordinates projection sessions; `codebase/data-service/control/sql-service.mjs`, whose `run` returns a `SqlResult`; and `codebase/data-service/control/cache-service.mjs`, whose `status`, `build`, and `clear` return `CacheStatus`, `CacheBuild`, and `CacheClear`.

**Excludes** semantic meaning. `file` is an internal data capability and is not a public CLI target.

**Relation** the four semantic services request these capabilities through the Unified Data Service and, for Codebase, the shared persistent FileBlock storage. They do not own those lifecycles, and no service may bypass the Unified Data Service to keep a second persisted semantic state.

## CLI

**Owns** argv admission, schema routing, service invocation, and result or error transport. It is a thin projection of the single nested `tools.schema` contract.

**Excludes** business logic, domain result shaping, FileBlock mutation, and any second command catalog.

**Located at** `codebase/cli/`, with `help-text.mjs` rendering the seven-entry catalog and the handbook-defined routing contract.

## Storage and integration

`file_blocks` is the only persistent semantic storage table and holds Codebase FileBlocks. Handbook, Rule, and Skill FileBlocks live in an in-memory database for the request and are searched with SQL in real time. Its value is JSONB and may contain source-addressable frontend evidence. `nodes`, `edges`, and `file_ast` are read-only SQL projections, never normalized storage. `token_weight` remains a source-backed capability projection. Cache manifests and releases contain lifecycle metadata only.

The persistent cache is one SQLite database per normalized root at `<paths.cacheDir>/<root-hash>/cache.db` (default `~/.ctx/cache`), resolved by `RootStore`, so each worktree or cwd is an independent unit (see ADR-007 in [[handbook/decisions]]). `FileBlockStore` owns the connection and its close lifecycle and composes the schema, FileBlock, `files` ledger, owner manifest, and publication targets; each consumer is given only the target it uses.

The four semantic owners (rules, skills, handbook, codebase) are cleanly declared in `codebase/owners/persistent-owners.mjs` through `PERSISTENT_OWNER_DEFINITIONS`, each connecting directly to its single-responsibility producer (`rules.mjs`, `skills.mjs`, `handbook-producer.mjs`, `codebase-loader.mjs`) without intermediate wrapper classes. They collaborate by composition, none extends another, and all public/internal calls follow `target.method(payload)`. Today Rule and Skill FileBlocks are published to the per-root cache while Handbook is ingested into doc-cache and detached from SQL graph tables (ADR-008, ADR-009, ADR-010).

## Related

[[handbook/architecture]], [[handbook/flow]], [[handbook/contract]]
