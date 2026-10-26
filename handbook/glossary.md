---
tags: [handbook, definition, glossary]
description: "One preferred meaning for each recurring term, plus the distinctions that are easy to get wrong."
version: 2
---

# Glossary

One preferred meaning per term. Where a term has a historical meaning that is no longer accepted, the historical form is named so it is not reintroduced by mistake.

## Semantic layer

**Handbook** — the product's canonical what, why, who, when, and where. A set of Obsidian-compatible notes, indexed by `handbook/README.md`.

**Semantic service** — one of Rule, Skill, Handbook, or Codebase. Each admits its own source and emits its own bounded result. There are exactly four.

**Owner** — the party responsible for one admitted source surface. Every owner builds one complete FileBlock per admitted file; only Codebase's are published to the persistent cache. An owner is not a projection and does not own another's lifecycle.

**Boot card** — `AGENTS.md` at the worktree root. It carries agent entry rules, the product boundary, the frozen invariants, the implementation contract, and the development method.

**Projection** — a read-only view derived from FileBlocks. A projection is never an input to the layer that produced it.

**Registry** — a generated or duplicated index. A registry is never the truth and must not exist beside one.

## Data layer

**FileBlock** — one complete JSONB value for one admitted source file, identified by owner, root, relative path, content hash, format, producer version, capability, and value. This is the only semantic form: it is persisted for Codebase and held in memory for the other owners.

**Document FileBlock** — the FileBlock of a Handbook, Rule, or Skill file. It lives only for the request, in an in-memory database that SQL searches in real time, and is never written to the persistent cache.

**OwnerInput** — the path-plus-hash set of a root's admitted source files, as computed by one owner.

**OwnerManifest** — the persisted digest of an OwnerInput together with its FileBlock revision set. Its digest equality with the current OwnerInput is the first half of the freshness predicate. Only Codebase has one, because only Codebase is persisted.

**Freshness** — the state where the stored manifest digest equals the current OwnerInput digest *and* the stored FileBlock revision set and count equal the manifest. Row presence, a cache event, an mtime match, and a passing test are never freshness evidence.

**Node / Edge** — projection row shapes, not storage and not owners. Canonical shape is `nodes(name, structure, behavior)` and `edges(frompath, topath)`, with endpoint grammar `<node>#structure[.<path>]` or `<node>#behavior[.<path>]`.

**`node_rows` / `edge_rows`** — the only two persisted derived tables. They are non-canonical, retain the complete FileBlock address and source JSON path, and are rebuilt atomically from the Codebase FileBlocks in `file_blocks`.

**`file_ast`** — the retained AST JSONB inside a FileBlock, read for bounded AST access. It is evidence, not a separate index.

**Structure / behavior** — on a node, `structure` is what the object is made of and `behavior` is what it does. A relation connects addressable surfaces and carries no meaning of its own beyond the connection.

## Capability layer

**Target** — the address and service boundary of a public operation. There are seven: `help`, `sql`, `cache`, `rule`, `skill`, `handbook`, `codebase`.

**Method** — the operation within a target.

**Payload** — the admitted input contract, a single value validated against the method's declared attributes.

**Call** — one invocation with the uniform shape `target.method(payload)`.

**`tools.schema`** — the single canonical nested public definition of target, method, and payload. Help, usage, argv metadata, and routing are projections of it.

**ToolsApi** — the capability surface through which all runtime calls and cross-owner composition enter. A service obtains its dependencies as injected targets rather than constructing peers.

**Error Object** — the failure value a call returns when input validation fails. It is transported through the standard error transport with a non-zero result.

**Result Object** — a bounded result value. Output is not gated by an output schema and is not rejected merely for shape.

## Document layer

**Rule** — a binding constraint, invariant, permission, or prohibition. It states what must or must not be true, and to whom the constraint applies.

**Skill** — reusable how and when. A skill describes a repeatable procedure in a defined situation; it cannot override a governing rule or decide product truth.

**Handbook note** — a long-lived handbook document carrying exactly three one-line properties: `tags`, `description`, and `version`. `version` is a per-note integer content revision incremented only for approved semantic change.

**Wikilink** — an untyped note relationship. It records that one note points at another; it does not by itself assert ownership, implementation, or dependency. State the required meaning in the owning prose.

**Handbook graph** — a read-only view of the notes and their links that may be derived on demand. It is not persisted and not required (ADR-008). It does not infer imports, calls, ownership, or dependency semantics from code paths written in prose.

**Truth transition** — an approved change to what the handbook says. It requires updating the handbook first, reading it back, then updating projections, then source.

## Retired terms

These are no longer accepted. Each names a decision that displaced it; see [[handbook/decisions]].

**ContextQL** — a retired internal query language. Superseded by standard SQL as the public query surface.

**Normalized graph store** (`graph/graph.schema.json`, `nodes`/`edges`/`token_weight` as materialized storage) — retired by the FileBlock JSONB hard cut.

**`OwnerSnapshot`** — retired. There is no independently writable graph owner.

**Global composition commands** (`ask`, `map`, `trace`, `prove`, `inspect`, `pack`, `audit`, `doctor`, and global `find`/`grep`/`eval`) — retired. Operations are reachable only below their owning target.

**Unit block** — the retired XML handbook carrier: a flat `<unit>` element holding one `id`, `type`, and `tags`, a nested `<content>`, and flat sibling `<relation/>` elements. An older form carried the same information as a `relation="follows:…,part_of:…"` attribute on a `<block>` root. The handbook is now Markdown; the retired form is preserved under `.trash/handbook-xml-20260926/` and in git history at `56a8f5d`.

**Part-of chapter membership** — a retired structural relation. It was what made a block's chapter addressable without a graph store, and in the current accepted structure there is no equivalent: a note's role is expressed by the note's own content and by body wikilinks, not by a separate relation vocabulary.

## Related

[[handbook/definition]], [[handbook/architecture]]
