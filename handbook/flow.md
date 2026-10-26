---
tags: [handbook, architecture, flow, lifecycle]
description: "The ordered runtime path from a command string to a bounded result, the cache lifecycle states, and the failure routes at each step."
version: 2
---

# Flow

## What

The runtime DAG is:

```text
ContentOwner
  -> FileOwner.admit(root, declared scope)
  -> read each admitted file once, compute SHA-256
  -> OwnerInput
  -> OwnerManifest.digest
  -> paired Cache
  -> read-only SQL projection
  -> ToolsApi Call result
```

Admission comes first because cache identity is meaningless before the allowed source set is known. Reading each admitted file once and hashing it is what makes freshness content-addressed rather than timestamp-based.

## The route

```text
CLI shell
  -> tools.schema payload admission      (validate argv against the method's payload)
  -> command owner                      (resolve target.method, load the owner)
  -> service or control entry           (one semantic service, or sql/cache)
  -> ContentOwner                       (decide the declared scope for this root)
  -> FileOwner.admit                    (apply global safety exclusions, then repository policy)
  -> producer / parser                  (build one complete JSONB FileBlock per admitted file)
  -> cache decision                     (Codebase only: reuse, rebuild, or fall back)
  -> FileBlock JSONB                    (file_blocks for Codebase; an in-memory database for Handbook, Rule, Skill)
  -> derived rows and read-only views   (node_rows / edge_rows for Codebase, file_ast, SQL projections)
  -> bounded result                     (with owner, revision, path, freshness, continuation)
```

## Cache lifecycle

Five states describe one lifecycle. None of them grants permission to return stale or invented context. The lifecycle applies to Codebase, the only persisted owner; Handbook, Rule, and Skill are produced for each request and have no manifest and no lifecycle state (ADR-008 in [[handbook/decisions]]).

| State | Meaning |
| --- | --- |
| `missing` | No owner manifest exists. |
| `stale` | An admitted input, producer generation, projection version, or FileBlock revision set no longer matches. |
| `fresh` | The manifest and the exact FileBlock set pass integrity checks. |
| `fallback` | The producer returned direct in-memory FileBlocks because persistence failed. |
| `unavailable` | A required admission or producer capability could not run. |

These five are the lifecycle states. They are not the same vocabulary as the four receipt values a cache command reports — `fresh`, `rebuilt`, `fallback`, and `unavailable` — which describe what happened on a single run. `missing` and `stale` are lifecycle-only and never appear as a receipt, and `rebuilt` is receipt-only and is not a resting lifecycle state.

## Cache contract terms

Four terms bound the cache and are not interchangeable with the states above.

- **Manifest predicate** — the test that decides whether a stored owner manifest still matches the current OwnerInput and FileBlock set. It is the only basis for a freshness claim.
- **Atomic publication boundary** — the single transaction in which changed rows, removed-file deletions, and the new manifest become visible together, so a reader never observes a mixture of two generations.
- **Codebase-only block reuse** — reuse of an already-published FileBlock is permitted only on the Codebase side. Other owners rebuild rather than reuse a block across an owner boundary, which keeps each owner's FileBlock attributable to its own producer.
- **Abnormal-state recovery route** — the declared path out of each non-`fresh` state, so an abnormal state has a named recovery rather than degrading silently.

An owner is fresh only when its stored manifest digest equals the current OwnerInput digest **and** the stored FileBlock revision set and count equal the manifest. Persistent row presence, a cache event, an mtime match, or a passing test is never freshness evidence. Projections have an independent version and never become freshness truth.

FileBlock reuse is content-addressed: matching owner, root, relative path, SHA-256 content hash, and producer version are sufficient to reuse the complete JSONB value.

Cache starts after the owner producer is correct. A no-cache execution produces the canonical result. A cold run may write it. A warm run compares the owner input manifest and the projection version, then reads the same canonical identity and relations. A stale run produces again. A cache failure falls back to the producer with an audit warning; it cannot alter semantics or create a cache-specific schema branch.

## Rebuild and publication

On a miss, the owner rebuilds only the changed FileBlocks, and the coordinator publishes the changed rows, the removed-file deletions, and the new manifest in one transaction. Readers observe one complete file-revision generation, never a mixture.

No node, edge, relation, or named view is updated separately, because every projection is derived from FileBlocks. A fresh manifest with matching FileBlock revisions projects immediately; a stale or missing revision rebuilds only that file's complete JSONB value first.

## Owner workflow

Every owner follows the declared workflow:

```text
resolve -> admit -> produce -> serialize -> validate -> publish -> cache_proof
```

An owner may mark a step non-applicable only in its own contract.

## Failure routes

| Condition | Route |
| --- | --- |
| Cache unavailable | Fall back to direct in-memory FileBlocks with a fallback receipt. |
| Cache write or read fails during an otherwise valid run | Fall back to the producer with an audit warning. A cache failure cannot alter semantics or create a cache-specific schema branch. |
| `FileOwner` or a required frontend unavailable | Return an unavailable result plus a recovery route. |
| Git needed but unavailable during admission | Return unavailable naming `GIT_UNAVAILABLE`, and tell the caller to install Git or use an explicitly non-Git root. |
| Target owner unavailable | Return the error through the standard error transport with a non-zero result. |
| Input validation fails | Fail the call with an Error Object. |
| Cache invalidated | Return to FileBlock hashes. A fresh cache hit queries the derived rows without hydrating complete FileBlocks into Node.js. |

A fallback preserves the invariant and discloses its reduced capability. It never silently converts failure into success.

## Agent operation route

An agent operation starts with a task, symptom, or question. The first move is semantic orientation in the handbook: identify the object, the domain, the constraint, the owner, and the required proof. The runtime then supplies a structural seed and addressed relations from SQLite, and source inspection supplies current evidence. Selection happens only after those boundaries are known.

```text
task -> handbook orientation -> structural seed and owner
     -> mandatory cross-source closure -> legal runtime/code expansion
     -> bounded projection -> action, continuation, and proof
```

## Source semantics retained

### `ctx.cache`

Cache starts after the owner producer is correct. No-cache execution produces the canonical result. A cold run may write it. A warm run compares the owner input manifest and projection version, then reads the same canonical identity and relations. A stale run produces again. A cache failure falls back to the producer with an audit warning; it cannot alter semantics or create a cache-specific schema branch. The Cache Contract defines the manifest predicate, atomic publication boundary, codebase-only block reuse, and abnormal-state recovery route.

### `ctx.dag`

The runtime DAG is ContentOwner -> FileOwner.admit(root, declared scope) -> read each admitted file once and compute SHA-256 -> OwnerInput -> OwnerManifest.digest -> paired Cache -> read-only SQL projection -> ToolsApi Call result. A fresh manifest with matching FileBlock revisions projects immediately; a stale or missing revision rebuilds only that file's complete JSONB value, then publishes changed rows, removed-file deletions, and the new manifest atomically. No node, edge, relation, or named view is updated separately because every projection is derived from FileBlocks. Cache unavailable falls back to direct in-memory FileBlocks with a fallback receipt; FileOwner or required frontend unavailable yields an unavailable result plus recovery route. Admission comes first because cache identity is meaningless before the allowed source set is known.

### `ctx.freshness`

An owner is fresh only when its stored manifest digest equals the current OwnerInput digest and the stored FileBlock revision set and count equal the manifest. Persistent row presence, a cache event, an mtime match, or a passing test alone is never freshness evidence. FileBlock reuse is content-addressed: matching owner, root, relative path, SHA-256 content hash, and producer version are sufficient to reuse the complete JSONB value. On a miss, the owner rebuilds only changed FileBlocks and the coordinator publishes changed rows, removed-file deletions, and the new manifest in one transaction. Readers observe one complete file-revision generation, never a mixture; projections have an independent version and never become freshness truth.

### `ctx.state`

missing means no owner manifest exists. stale means an admitted input, producer generation, projection version, or FileBlock revision set no longer matches. fresh means the manifest and exact FileBlock set pass integrity checks. fallback means the producer returned direct in-memory FileBlocks because persistence failed. unavailable means required admission or producer capability could not run. These states describe one lifecycle; none grants permission to return stale or invented context.

## Related

[[handbook/modules]], [[handbook/evidence]], [[handbook/routing]]
