---
tags: [handbook, contract, routing]
description: "How an agent or a runtime consumer enters the handbook, what the pre-read route requires, and how the handbook evolves without producing two truths."
version: 2
---

# Routing

## What

The handbook is a route, not a standalone skill and not a semantic implementation. It owns route meaning and the required closure. The selected responsibility skill owns procedure. The boot card owns the mandatory pre-read gate. This separation is deliberate: the handbook states what is true and what must be consulted; a skill states how to act; neither may decide the other's truth.

## Agent route

An agent operation starts with a task, a symptom, or a question. The first move is semantic orientation in the handbook: identify the object, the domain, the constraint, the owner, and the required proof.

```text
task
  -> handbook orientation        (object, domain, constraint, owner, required proof)
  -> structural seed and owner   (addressed relations from the runtime)
  -> mandatory cross-source closure
  -> legal runtime and code expansion
  -> bounded projection
  -> action, continuation, and proof
```

Selection happens only after those boundaries are known. A route that selects before it knows the owner is not admissible.

## Pre-read and skill selection

Before planning or acting, read the handbook route material, then select exactly one primary responsibility skill. Other owners are closure or handoff only.

The previous pre-read named these unit identifiers: `operations-route`, `operations-call`, `operations-grammar`, `operations-skill-router`, and `operations-development-pipeline`. In the Markdown handbook the corresponding meaning lives in this note, in [[handbook/contract]], and in the development method recorded in the boot card. The identifiers themselves are retired with the XML form; see [[handbook/glossary]].

If no moment is admissible, return an explicit anomaly and stop. Do not infer a new owner, a new route, a new schema, or direct peer wiring. All runtime calls and cross-owner composition enter through the capability surface.

## Runtime consumption route

The XML carrier is retired and the runtime handbook module is disabled. When it returns, the accepted route under ADR-008 in [[handbook/decisions]] is:

```text
handbook note (Markdown, with properties and wikilinks)
  -> admitted as one complete JSONB FileBlock per note, held in memory for the request
  -> real-time SQL over that JSONB
  -> selection by identifier, tag, or link, or text search
  -> bounded Handbook result
```

Selection addresses a note by its identifier, by its `tags` property, or through a declared relation. Those three are the addressing forms; there is no fourth addressing scheme and no separate index that answers a fourth question. Text search is a query over note content, not a fourth addressing form.

The runtime selects notes, resolves declared relations, validates the invariants the notes state, and joins them with other owner values. Every runtime query row is derived and is never a second product definition. A projection must not be able to make a claim the note does not make.

## Evolution route

Schema and structure evolution must not create two truths.

The handbook notes and the runtime projection derived from them are canonical. Any diagram — including a Mermaid rendering — and any generated table, index, or view is a read-only projection for review. A diagram exists to help a reader see a structure; it never becomes the structure's definition. When a note or a relation changes, update the handbook first, then verify the structure check and re-render the diagram. Do not create a separate registry, and do not let a projection become the source of truth.

Concretely, a change proceeds as:

```text
approved decision -> handbook note -> read-back of notes and links
                  -> SQLite projection -> source -> gate
```

If a handbook and source conflict appears, stop at that point and return to the handbook owner. If a proof is unavailable, keep the plan in a validating state rather than claiming completion.

## What the graph does not do

The handbook graph records note relationships only. It does not infer imports, calls, ownership, or runtime dependencies from code paths written in prose. A wikilink is an untyped edge; the relationship's meaning belongs to the prose of the note that declares it. Source dependency questions go to the responsible code-analysis owner.

## Source semantics retained

### `evolution-route`

Schema evolution must not create two truths. The handbook unit-block store and ctx projection are the canonical source; Mermaid is a read-only projection for review. When a unit or relation changes, update the handbook first, then verify the graph check and Mermaid projection. Do not create a separate registry or let Mermaid become the source of truth.

### `purpose-handbook-role`

The product's semantic foundation is the Handbook. It states product purpose, object meanings, owner boundaries, legal relations, lifecycle, operations, proof, and evolution. ctx admits the Handbook source files into complete JSONB FileBlocks and uses SQL to select blocks, resolve declared relations, validate invariants, and join them with other owner values. Runtime query rows are derived and never a second product definition.

### `operations-route`

An agent operation starts with a task, symptom, or question. The first move is semantic orientation in the Handbook: identify the object, domain, constraint, owner, and required proof. ctx then supplies a structural seed and addressed relations from SQLite. Source inspection supplies current evidence. Selection happens only after those boundaries are known. Route: task -> Handbook orientation -> structural seed and owner -> mandatory cross-source closure -> legal runtime/code expansion -> bounded projection -> action, continuation, and proof.

### `operations-skill-router`

The repo-skill-router is a Handbook route, not a standalone Skill or semantic owner. Handbook owns route meaning and required closure; the selected responsibility Skill owns procedure; the boot card owns the mandatory pre-read gate. Before plan or act, read this block with operations-route, operations-development-pipeline, operations-call, and operations-grammar through ctx handbook, then select exactly one primary responsibility Skill. Other owners are closure or handoff only. All runtime calls and cross-owner composition enter through ToolsApi. If no moment is admissible, return an explicit anomaly and stop; do not infer a new owner, route, schema, or direct peer wiring.

## Related

[[handbook/definition]], [[handbook/contract]], [[handbook/decisions]], [[handbook/evidence]]
