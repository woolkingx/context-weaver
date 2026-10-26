---
tags: [handbook, definition, product]
description: "What Context Weaver is, the problem it solves, who it serves, its scope, and its explicit non-goals."
version: 3
---

# Definition

## What

Context Weaver is a repo-native FileBlock context compiler for coding agents. It turns rules, skills, handbook meaning, source and AST evidence, cache state, and runtime audit evidence into bounded SQLite projections exposed through one Unix-like `target.method(payload)` CLI.

It exists because a string match can tell an agent where text appears, but it cannot tell which owner, rule, cache partition, or proof gate applies. Context Weaver gives an agent a project coordinate system before it edits code or makes an architecture claim.

The product surface is one CLI with seven first-level targets: `help`, `sql`, `cache`, `rule`, `skill`, `handbook`, and `codebase`. Of these, four are semantic services — Rule, Skill, Handbook, and Codebase — and `help`, `sql`, and `cache` are control and data entries. See [[handbook/contract]] for the observable contract and [[handbook/modules]] for what each service owns.

The canonical route is fixed:

```text
source -> FileBlock JSONB -> SQL projection -> operation -> implementation -> proof
```

Every semantic source file is admitted as one complete JSONB FileBlock. Codebase FileBlocks are persisted in the cache, and its objects, relations, selections, diagnostics, named views, and command results are SQL projections over those revisions. Handbook, Rule, and Skill FileBlocks exist only for the request, in an in-memory database that SQL searches in real time; they are not persisted and need no graph rows (ADR-008 in [[handbook/decisions]]). The CLI and any future Web UI are projections of that data, not a second definition of the product.

## Why

Agents fail on repository work not because they cannot find text, but because they act without knowing which object they are changing, who owns it, what invariant binds it, and what evidence would prove the change correct. Raw `rg` or `find` hits do not carry that meaning.

Context Weaver therefore compiles project truth sources into agent-usable context:

- `AGENTS.md` rules
- Handbook meaning from this directory
- File-level JSONB FileBlocks from the four semantic owners, with persisted SQLite projections for Codebase
- Skill contracts
- Schemas and specifications
- Source files, symbols, tests, configuration, and dependency edges

The Handbook owns product meaning and architecture reasoning. The runtime builds one complete JSONB FileBlock per admitted source file, persists the Codebase ones, and derives query rows from them. Runtime storage is not a second product definition, and a projection must never be mistaken for the truth it projects.

## Who

- **Handbook** owns what the product is, why it exists, who owns what, when its meaning applies, and where the truth lives. It is the `handbook` semantic service.
- **Rule** owns project and global `AGENTS.md` constraints.
- **Skill** owns project and configured global `SKILL.md` procedures.
- **Codebase** owns admitted implementation files, parser evidence, and complete ASTs.
- **Unified Data Service** owns the `file`, `sql`, and `cache` capabilities that the four semantic services request. It is not a fifth semantic owner.
- **CLI** is a thin router over those capabilities. It owns argument admission, schema routing, service invocation, and output or error transport, and nothing else.
- **The caller** — usually an agent — is the only party permitted to combine information across modules, and it does so by making separate calls and interpreting the separate results.

`AGENTS.md` at the worktree root is the boot card for this repository. It carries the entry route, the product boundary, the frozen architecture invariants, the implementation contract, and the development method, and it is read before anything else.

## When

This truth applies while the seven-entry CLI, the four independent semantic services, the Unified Data Service ownership boundary, and the FileBlock JSONB ground model remain the accepted architecture.

Review it when the execution boundary changes, when a new semantic service is proposed, when the storage ground model changes, or when a decision recorded in [[handbook/decisions]] is superseded. A proposal that changes any of these is a truth transition: this handbook is updated and read back before a plan or source change begins.

## Where

| Concern | Canonical location |
| --- | --- |
| Product and architecture meaning | `handbook/`, indexed by `handbook/README.md` |
| Agent entry rules, product boundary, invariants, development method | `AGENTS.md` |
| Public command definition | `common/tools/tools.schema.json` (JSON Schema Draft-07), loaded through `common/tools/tools.schema.mjs` |
| Implementation | `codebase/` |
| Data and tool contracts | `common/` |
| Execution plans | `docs/plan/` |
| Evidence and review records | `docs/report/`, `docs/reports/` |
| Reusable agent procedures | `.claude/skills/*/SKILL.md` |
| Public orientation projection | `README.md`, `CHANGELOG.md` |

The root `README.md` and `CHANGELOG.md` are GitHub-facing projections. They may summarize or link to handbook truth but must not introduce a competing definition of purpose, ownership, boundary, or invariant. Procedures belong in skills and references, not in the handbook.

The pre-migration XML unit blocks are preserved locally at `.trash/handbook-xml-20260926/`. That path is git-ignored and is recovery material for this machine only, not a canonical location; the same files remain retrievable from git history at commit `56a8f5d`.

## Scope

In scope: compiling admitted repository truth sources into bounded, inspectable, agent-usable context; one canonical public command definition; four independent semantic services; a shared Unified Data Service for file admission, SQL projection, and cache lifecycle; content-addressed freshness; and read-only projections that retain provenance.

## Non-goals

Context Weaver is not a chatbot, a memory system, a vector database, or a replacement for `rg`. It does not merge the four semantic services into a single composed answer, does not own a second normalized graph store, and does not let a projection become semantic input. Persistent row presence, a cache event, an mtime match, or a passing test is never freshness evidence. Token reduction must never be confused with semantic completeness: every bounded projection reports its bounds, its omissions, and its continuation.

## Related

[[handbook/contract]], [[handbook/architecture]], [[handbook/glossary]]
