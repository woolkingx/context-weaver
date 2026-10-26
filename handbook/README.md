---
tags: [handbook, index, context-weaver]
description: "Navigation index and reading order for the Context Weaver handbook; the product's canonical what, why, who, when, and where."
version: 4
---

# Context Weaver Handbook

The handbook is the product's semantic foundation. It states product purpose, object meanings, owner boundaries, legal relations, lifecycle, operations, proof, and evolution. The accepted runtime contract is to admit these notes into complete JSONB FileBlocks held in memory for the request and use SQL to select and search them and resolve declared relations; every runtime query row is derived and is never a second product definition. The XML carrier is retired and the runtime handbook module is disabled, so this target contract is not yet active against these notes.

This index exists for navigation and reading order. It is not a registry, and it does not restate the meaning owned by the notes it links.

## Reading order

```text
definition -> contract -> architecture -> modules -> flow
            -> decisions -> evidence -> glossary -> routing
```

Read [[handbook/definition]] first to establish what the product is and where its boundary lies. Read [[handbook/contract]] before changing any public surface. Read [[handbook/architecture]], [[handbook/modules]], and [[handbook/flow]] before changing runtime topology. [[handbook/decisions]] records why the accepted structure looks the way it does, so a proposal that contradicts a recorded decision must supersede that decision rather than ignore it. [[handbook/evidence]] states what currently proves the contracts and what does not. [[handbook/glossary]] fixes vocabulary. [[handbook/routing]] describes how an agent or a runtime consumer enters and leaves this handbook.

## Chapters

| Note | Question it answers | Layer |
| --- | --- | --- |
| [[handbook/definition]] | What is this product, for whom, and what is explicitly out of scope? | Definition |
| [[handbook/contract]] | What observable behavior must hold at the public surface, and how is it judged? | Contract |
| [[handbook/architecture]] | What parts and relationships realize those outcomes, and what constraints bind them? | Architecture |
| [[handbook/modules]] | What does each module own, exclude, and expose? | Architecture |
| [[handbook/flow]] | What happens, in order, from a command string to a bounded result? | Architecture |
| [[handbook/decisions]] | Which choices materially shaped the system, and what did they displace? | Architecture |
| [[handbook/evidence]] | What demonstrates a claim is true, and what does that evidence not prove? | Evidence |
| [[handbook/glossary]] | What do the recurring terms mean, and which distinctions matter? | Definition |
| [[handbook/routing]] | How does an agent or the product enter this handbook and act on it? | Contract |

## Truth

- This handbook owns product meaning and architecture reasoning.
- `AGENTS.md` at the worktree root is the boot card: it carries agent entry rules, the product boundary, frozen invariants, and the development method for this repository.
- `common/tools/tools.schema.json` (JSON Schema Draft-07) is the single canonical public API schema: every `target.method` payload, its defaults and its argv keywords are defined there. `common/tools/tools.schema.mjs` only loads it through `schema2object`. The `help` projection renders it; nothing else defines a command tree.
- `codebase/` implements the admitted surfaces. A change to architecture or ownership meaning updates this handbook first, then the SQLite projection, then source.

The handbook, the canonical schema, and the implementation must stay in sync. When a method changes, update the schema, its handbook contract, and its owner implementation together.

## Format

Handbook notes are Obsidian-compatible Markdown. Each note carries exactly three one-line properties — `tags`, `description`, and `version` — where `version` is a per-note integer content revision that increments only for approved semantic change, never for formatting. One wikilink is one note relationship; the relationship's meaning is stated in the prose of the owning note, because a link records a note relationship and does not by itself assert ownership, dependency, or runtime behavior. Source locations appear as inline code paths rather than as fabricated links, since a code path is source evidence and not a vault node.

The handbook graph is a read-only projection of these notes. It does not infer imports, calls, ownership, or dependency semantics from code paths written in prose; source dependency questions belong to the responsible code-analysis owner.

## Ingestion and status

The handbook notes are canonical Markdown truth. Ingestion into doc-cache is supported in dual-format (`ob` Obsidian Markdown and legacy `xml` unit blocks) via `HandbookStore` (`codebase/handbook/unit-block-store.mjs`), which parses them into standard `handbook_block` JSONB FileBlocks. Per ADR-008 and ADR-009, handbook blocks are retained in document cache for full-text search and are detached from persistent relational SQL tables (`node_rows`, `edge_rows`) to eliminate graph bloat. The public `ctx handbook` CLI method remains in maintenance status while human/agent inspection directly reads these notes. The pre-retirement XML unit blocks remain preserved under `.trash/handbook-xml-20260926/` and git history at `56a8f5d`.
