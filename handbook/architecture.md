---
tags: [handbook, architecture, runtime]
description: "System context, the FileBlock ground model, projection layers, and the constraints that bind every architectural change."
version: 2
---

# Architecture

## What

The system compiles admitted repository truth sources into bounded, inspectable context. It has exactly one semantic storage ground model, one public command definition, and one derived projection layer.

The ground model is a single complete JSONB FileBlock per admitted source file, identified by owner, root, relative path, content hash, format, producer version, capability, and JSONB value. `file_blocks` is the only persistent semantic storage table. Everything else that looks like storage — `nodes`, `edges`, `file_ast`, `node_rows`, `edge_rows`, cache manifests, releases — is either a read-only SQL projection or lifecycle metadata. `file_blocks` is persistent only for Codebase; Handbook, Rule, and Skill FileBlocks are held in memory for the request (ADR-008 in [[handbook/decisions]]).

## Layers

```text
CLI shell
  -> tools.schema payload admission
  -> command owner
  -> service (rule | skill | handbook | codebase) or Unified Data Service control
  -> ContentOwner
  -> FileOwner.admit(root, declared scope)
  -> producer / parser
  -> FileBlock JSONB
  -> indexed derived rows
  -> read-only SQL projection
  -> bounded result with provenance
```

One owner per layer. A layer never reaches around the layer above it to a peer, and a projection never becomes an input to the layer that produced it.

## Persistence scope

Only Codebase is persisted in the cache and projected into derived rows. Handbook, Rule, and Skill keep the FileBlock as their processing form, built by the owner producer from files that `FileOwner` admits, but those FileBlocks live in an in-memory database for the request. They have no manifest, no freshness state, and no required node or edge rows; their text is found by real-time SQL search over the JSONB. See ADR-008 in [[handbook/decisions]].

## Projection layer

Every operation reads FileBlock JSONB through read-only SQL projections. `object_view`, `relation_view`, `graph_nodes`, `graph_edges`, bounded `GraphTraversal`, `architecture_view`, `workflow_view`, `sequence_view`, `dataflow_view`, `lifecycle_view`, and selection are query shapes over the same file revisions. A GraphNode or GraphEdge is a projection row shape, not a fifth semantic owner and not an independently writable graph store.

SQLite may persist exactly two non-canonical, fully derived acceleration tables, `node_rows` and `edge_rows`. Each retains the complete FileBlock address and source JSON path, and both are atomically rebuilt from the Codebase FileBlocks in `file_blocks`. Public `nodes`, `edges`, `graph_nodes`, and `graph_edges` views read those derived rows during ordinary queries, while `file_ast` may read the retained AST JSONB for bounded AST access. A fresh cache hit must query the derived rows without hydrating complete FileBlocks into Node.js.

Projected rows retain owner, cache key, root, file path, source JSON path or range, raw endpoint paths, relation kind, producer generation, freshness, and capability, so an agent can inspect the evidence behind any row it receives.

## Projection levels

Projections use two levels so an agent can orient quickly without losing a proof route.

The first level is a bounded object or relation summary with grouped adjacency and omitted counts. The second is material evidence carrying owner, file revision, JSON path or source range, relation kind, capability, and freshness. A summary may group repeated rows by source and relation, but it cannot replace FileBlock identity or source evidence.

`GraphTraversal` must declare owner, cache key, root, producer generation, seed identity, maximum depth, and cycle policy, and must actually use cycle protection rather than rely on the declared value. Raw endpoint paths, duplicate multiplicity, unresolved targets, and omitted continuation remain inspectable. Duplicate raw edges stay query-visible; duplicate projected relations remain quality findings. Every projection reports its bounds, its omissions, and its continuation, so token reduction is never confused with semantic completeness. Progress and audit events remain operational side channels and must not replace or interleave with structured result blocks.

## Shared concepts

Some concepts are used by every target without being owned by any of them. Ontology, lifecycle, and evidence vocabulary is shared: it appears across Rule, Skill, Handbook, and Codebase, and the targets that use it do not own commands on its behalf. The distinction matters because it keeps shared vocabulary from silently becoming a fifth owner. A concept becomes an owner only when some party is responsible for admitting, producing, and publishing its source; until then it is vocabulary, and vocabulary belongs in [[handbook/glossary]] and in the contract and architecture notes, not in a service boundary.

## Constraints

These bind every architectural change.

- **One canonical command definition.** `tools.schema` owns public `target → method → payload` identity, argv admission, and help metadata. There is no second CLI catalog or public API routing layer.
- **One admission owner.** `FileOwner` is the only cwd-local filesystem admission owner.
- **One storage ground model.** FileBlock JSONB, hard-cut. The graph module, graph schema, `OwnerSnapshot`, and compatibility adapters are retired. Old cache formats are rejected with an explicit rebuild route; they are not migrated into a parallel truth.
- **Derived rows are never semantic input.** `node_rows` and `edge_rows` are rebuilt atomically and never become a second schema, producer, semantic snapshot, or behavior branch.
- **No inheritance-based domain boundaries.** No `extends`, `super`, or base-owner hierarchies. Use composition, module imports, and explicit delegation.
- **No hidden domain state.** Class instances must not hide undocumented state, invent private schemas, or become service bags. Instantiate stateful classes at composition roots or test fixtures, then pass the target capability down rather than constructing peers in the semantic mainline.
- **The official frontend is the AST authority.** `AstSymbolSensor` uses the TypeScript Compiler API as the official JS/TS AST frontend. Zero-dependency is scoped to core logic; producer adapters may depend on the official compiler frontend for their language. Adding a language means adding its official producer, serializing the complete frontend result into the same FileBlock envelope, and defining SQL projections for the supported semantics.
- **No silent truth transitions.** A change to architecture or ownership meaning updates this handbook first, then its SQLite projection, then source, and passes `node scripts/check-architecture-contract.mjs`.

## Structure and behavior

A useful projection represents a system, not only topology. An object retains structure and performs behavior; a relation only connects addressable surfaces. Canonical rows are therefore `nodes(name, structure, behavior)` and `edges(frompath, topath)`, with endpoint grammar `<node>#structure[.<path>]` or `<node>#behavior[.<path>]`. Function signatures, variables, calls, arguments, and returns stay below their owning file or class surface unless they have independent object identity. Relation meaning comes from the source surface path — `invokes`, `validates`, `children`, and so on — which prevents a global edge-type taxonomy from exploding while preserving reverse interpretation.

## Change discipline

New architecture or owner changes update the owning handbook chapter first, then the SQLite projection, before any source change. A design that cannot map onto the development spine above is not admitted to source. Topology changes update the architecture contract and its skill before implementation. See [[handbook/decisions]] for the accepted structure and [[handbook/evidence]] for the gate that checks it.

## Source semantics retained

### `ctx.ontology`

Every ctx operation reads FileBlock JSONB through read-only SQL projections. object_view, relation_view, graph_nodes, graph_edges, bounded GraphTraversal, architecture_view, workflow_view, sequence_view, dataflow_view, lifecycle_view, and selection are query shapes over the same file revisions. GraphNode and GraphEdge are projection row shapes, not a fifth semantic owner or independently writable graph store. SQLite may persist exactly two non-canonical, fully derived acceleration tables, node_rows and edge_rows, each retaining the complete FileBlock address and source JSON path; they are atomically rebuilt from file_blocks and may never become an input or semantic owner. Public nodes, edges, graph_nodes, and graph_edges views read those derived rows during ordinary queries, while file_ast may read the retained AST JSONB for bounded AST access. Projected rows retain owner, cache key, root, file path, source JSON path or range, raw endpoint paths, relation kind, producer generation, freshness, and capability so an agent can inspect their evidence. Graph traversal is explicitly bounded by scope and depth and must use cycle protection; duplicate raw edges remain query-visible while duplicate projected relations remain quality findings. Invalidation returns to FileBlock hashes, and a fresh cache hit must query the derived rows without hydrating complete FileBlocks into Node.js.

### `operations-projection`

Query projections use two levels so an agent can orient quickly without losing a proof route: a bounded object or relation summary with grouped adjacency and omitted counts, and material evidence with owner, file revision, JSON path or source range, relation kind, capability, and freshness. A summary may group repeated rows by source and relation, but it cannot replace FileBlock identity or source evidence. GraphTraversal must declare owner, cache key, root, producer generation, seed identity, maximum depth, and cycle policy; raw endpoint paths, duplicate multiplicity, unresolved targets, and omitted continuation remain inspectable. Every projection reports bounds, omissions, and continuation so token reduction is never confused with semantic completeness. The seven first-level CLI entries are `help`, `sql`, `cache`, `rule`, `skill`, `handbook`, and `codebase`: `help` is a CLI control projection; `sql` and `cache` project the Unified Data Service `sql` and `cache` submodules; `file` is an internal data capability; and the four module entries address independent Rule, Skill, Handbook, and Codebase services. Each service emits its own bounded result; the CLI does not merge sibling service results. A caller that needs cross-module information performs four separate module calls and interprets the four result blocks itself. Progress and audit events remain operational side channels and must not replace or interleave with structured result blocks.

## Related

[[handbook/definition]], [[handbook/modules]], [[handbook/flow]], [[handbook/decisions]]
