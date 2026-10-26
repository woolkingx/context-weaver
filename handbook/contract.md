---
tags: [handbook, contract, cli]
description: "The observable public contract of the seven CLI entries, the target.method(payload) call shape, admission rules, boundaries, and error behavior."
version: 5
---

# Contract

## What

The canonical `tools.schema` uses one public command tree. A first-level entry addresses a target, a method names the operation, and the payload definition, argv metadata, help text, and owner routing all belong to that same schema surface:

```text
tools.schema
└── target
    └── method
        └── payload attributes
```

This structure keeps every CLI surface discoverable through `ctx help`, validated by JSON Schema Draft-07, and routed dynamically at runtime without a second CLI catalog or hard-coded command imports. Descriptions, help, usage, and argv fields are projections of the same method node. There is no `tools.cli` catalog, no flat command catalog, and no `apiRef` layer between the CLI and that one definition.

The seven first-level entries carry 19 methods in total. The method name is the schema identity; the usage string is its projection on the command line.

| Target | Kind | Methods | Usage |
| --- | --- | --- | --- |
| `help` | CLI control entry | `render` | `ctx help [--full]` |
| `sql` | Unified Data Service `sql` projection | `run` | `ctx sql "<SELECT ...>" [--root <path>] [--owners <list>]` |
| `cache` | Unified Data Service `cache` entry | `status`, `build`, `clear` | `ctx cache status [owners]`, `ctx cache build [owners]`, `ctx cache clear [owners]` |
| `rule` | Semantic service | `run` | `ctx rule [--root <path>]` |
| `skill` | Semantic service | `query`, `load`, `list` | `ctx skill query [term]`, `ctx skill load <name> [into...]`, `ctx skill list` |
| `handbook` | Semantic service | `read` (disabled; reports a maintenance status) | `ctx handbook [--chapter <name>\|--tags <list>\|--ids <list>]` |
| `codebase` | Semantic service | `relate`, `token`, `search`, `slice`, `contain`, `call`, `dep`, `data`, `seq` | `ctx codebase relate <token> [--top <n>]`, `ctx codebase token <set\|get\|row\|del> ...`, `ctx codebase search <query> [--limit <n>] [--path <prefix>]`, `ctx codebase slice <path> [--start <n>] [--end <n>]`, `ctx codebase contain <symbol> [--depth <n>]`, `ctx codebase call <symbol> [--direction <in\|out\|both>]`, `ctx codebase dep <symbol> [--direction <in\|out\|both>]`, `ctx codebase data <symbol>`, `ctx codebase seq <from> <to>` |

Each method node carries `description`, `help`, `usage`, and a `payload` whose attributes carry descriptions and argv metadata. `file` is an internal data capability of the Unified Data Service, not a public target.

`ctx handbook` is currently unavailable against the notes in this directory because the runtime handbook module is disabled and its rewrite is withdrawn by ADR-008 in [[handbook/decisions]]; see the known gap in [[handbook/README]]. The contract for that target is stated here as the accepted target state, not as current verified behavior.

## Call contract

The CLI is a thin projection of calls into stateful semantic Class Instances or named stateless APIs. Every command is a Call with the uniform shape `target.method(payload)`.

`tools.schema` admits and validates the input payload. The target is injected and allowlisted. Ports are injected. A call produces a bounded Result Object or evidence value and does not require an output-schema gate; output remains projection data and is not rejected merely for shape.

If one result is passed to another API, it becomes that receiving API's input and is validated only at the receiving boundary. No command invents a private schema, and no command performs arbitrary dynamic method dispatch. The payload is a JSON Schema Draft-07 value structure in `tools.schema.json`: `required`, `default`, `minimum`, `enum` and the argv keywords are properties of that schema and nowhere else. `CliApplication` converts argv to the payload and `schema2object` (`ObjectTree.from`) validates it and supplies the schema defaults before the target method is called, so a target owner receives a complete payload and declares no defaults of its own. `CliApplication` resolves `target.method`, validates argv against that method's payload attributes, converts argv into the payload object, and loads the target owner through internal implementation routing. No business command is hard-coded into it. If a target owner is unavailable, the error is returned through the standard error transport with a non-zero result. A semantic module (`rule`, `skill`, `handbook`, `codebase`) switched off by `modules.<name>: false` in the configuration is unavailable in this sense: `CliApplication` returns `MODULE_DISABLED` naming the module and the setting to enable, and does not load the owner. The switch defaults to on.

Cross-module information is obtained by the caller through separate module calls. Each result stays scoped to its module, and the caller interprets the results. The CLI does not merge sibling service results, and there is no global composition command, composition service, or merged CLI layer.

## Admission contract

`FileOwner` is the only cwd-local filesystem admission owner. It applies global safety exclusions before repository policy.

In a Git repository it uses Git standard exclusions, including the worktree pointer, `.gitignore`, `info/exclude`, and configured global excludes. In an explicitly non-Git root it reads nested `.gitignore` files plus a root `info/exclude` when present, and global safety exclusions still win. If Git is needed but unavailable, the owner result is unavailable, names `GIT_UNAVAILABLE`, and tells the caller to install Git or to use an explicitly non-Git root. A projection must preserve that state rather than collapsing it to missing.

`FilteredFilesystem` is `FileOwner`'s safety primitive, not a content owner. No owner may read around `FileOwner` or persist projected objects and relations as a second source.

What is admitted is then queryable. The `sql` submodule queries published FileBlocks by `id`, by `tags`, and by relation, and derives every object, relation, selection, diagnostic, and named view from those revisions. The `cache` submodule owns FileBlock freshness and lifecycle. Those three submodules are the whole of the Unified Data Service's responsibility.

OwnerInput is complete only when an added, removed, edited, newly excluded, or newly admitted file changes it. Every semantic owner computes one SHA-256 content hash per admitted source file and uses the path-plus-hash set as its file input, so an edit with unchanged mtime cannot reuse stale content. Rule and Skill owners may name additional global roots, each separately admitted through `FileOwner`. The tools target is the explicit exception: it admits the canonical `tools.schema` source rather than target-repository files.

## Boundary contract

Three rules define the CLI boundaries.

1. CLI owns argument parsing, validation, and routing only.
2. Each semantic module owns its business logic and its internal state.
3. No semantic module may import a peer module or own a data lifecycle.

The Unified Data Service owns the `file`, `sql`, and `cache` submodules: file admission and FileBlock publication, SQL projection, and cache freshness and lifecycle. Semantic modules request those capabilities through the Unified Data Service and shared FileBlock storage. The CLI must not mutate FileBlocks; it may only request changes through module methods.

`node_rows` and `edge_rows` are permitted only as non-canonical, fully derived acceleration tables rebuilt atomically from `file_blocks`. They never become semantic input, and there is no graph module, graph schema, `OwnerSnapshot`, or independently writable graph owner.

## Cache contract

`ctx cache status` asks the same coordinator predicate that load uses; it does not infer freshness from table existence. `ctx cache build` ensures the selected owners have current FileBlock revision sets; a true forced rebuild is a separate operation. Normal owner-backed commands automatically revalidate admitted inputs, reuse matching FileBlocks immediately, or rebuild changed files and publish atomically before querying.

The cache contract applies to Codebase, the only owner persisted under ADR-008 in [[handbook/decisions]]. While the Rule, Skill, and Handbook owners still pass through the same cache, `ctx cache` continues to report them; that is transitional, and a document owner has no required cache state.

Cache provenance is part of the runtime receipt — `fresh`, `rebuilt`, `fallback`, or `unavailable` — and must not be hidden behind a generic success state. See [[handbook/flow]] for the full lifecycle and [[handbook/evidence]] for what proves these behaviors.

## Acceptance meaning

Acceptance is judged against the public `target.method` input/output contract. Internal command state, private properties, call order, cache decisions, transport formatting, and debug details are not acceptance criteria and must not become test assertions; they belong to temporary probes, revisions, or runtime logs. A route can be proven only from an actual CLI invocation and its returned result or error; documentation readback and schema readback are separate evidence.

The procedure, the current lane, and the assertion policy are owned by `.claude/skills/test-system/SKILL.md`. This section states what counts as acceptance, not how to run it.

## Source semantics retained

### `ctx.admission`

FileOwner applies global safety exclusions before repository policy. In a Git repository it uses Git standard exclusions including worktree pointer, `.gitignore`, info/exclude, and configured global excludes. In an explicitly non-Git root it reads nested `.gitignore` files plus root info/exclude when present; global safety exclusions still win. If Git is needed but unavailable, the owner result is unavailable, names `GIT_UNAVAILABLE`, and tells the caller to install Git or use an explicitly non-Git root. A projection must preserve that state rather than collapsing it to missing.

### `ctx.boundaries`

CLI boundaries are defined by three rules: (1) CLI owns argument parsing, validation, and routing only; (2) each semantic module owns its business logic and internal state; (3) no semantic module may import a peer module or own data lifecycle. The Unified Data Service owns the `file`, `sql`, and `cache` submodules: file admission and FileBlock publication, SQL projection, and cache freshness/lifecycle. Semantic modules request those capabilities through the Unified Data Service and shared FileBlock storage. CLI must not mutate FileBlocks; it may only request changes through module methods. Permanent tests validate only the public `target.method` input/output contract. Internal command state, private properties, call order, cache decisions, transport formatting, and debug details belong to temporary probes, revisions, or runtime logs, not tests.

### `ctx.call`

CLI is a thin projection of calls into stateful semantic Class Instances or named stateless APIs. Each command is a Call with the uniform shape `target.method(payload)`. Tools Schema admits and validates the input payload; the target is injected and allowlisted; ports are injected; and Handbook route readback is scoped to the command's declared module or unified service route. A call produces a bounded Result Object or evidence value without requiring an output-schema gate; output remains projection data and is not rejected merely for shape. If one result is passed to another API, it becomes that receiving API's input and is validated only at the receiving boundary. No command invents private Schema or performs arbitrary dynamic method dispatch. A call fails with an Error Object if input validation fails. Cross-module information is obtained by the caller through four separate module calls; each result remains scoped to its module and is interpreted by the caller.

### `ctx.cli`

The canonical `tools.schema` uses one public command tree: one of the seven first-level entries (`help`, `sql`, `cache`, `rule`, `skill`, `handbook`, `codebase`) addresses a target, its method names the operation, and the payload definition, argv metadata, help, and owner routing belong to that same schema surface. This structure ensures each CLI surface is discoverable via `ctx help`, validated by JSON Schema Draft-07, and routed dynamically at runtime without a second CLI catalog or hardcoded command imports. The CLI does not own business logic; it reads `tools.schema` to build the command tree and delegates directly to the declared `target.method` implementation.

### `ctx.route`

CliApplication imports the canonical nested `tools.schema` to build a runtime command tree. For each incoming command string, it resolves the `target.method`, validates arguments against that method's payload attributes, converts argv into the payload object, and loads the target owner through internal implementation routing. Descriptions, help, usage, and argv fields are projections of the same method node; there is no `tools.cli`, `apiRef`, or second command catalog. No business command is hard-coded into CliApplication. If a target owner is unavailable, the error is returned through the standard error transport with a non-zero result.

### `ctx.input`

OwnerInput is complete only when an added, removed, edited, newly excluded, or newly admitted file changes it. Every semantic owner computes one SHA-256 content hash for each admitted source file and uses the path-plus-hash set as its file input; an edit with unchanged mtime therefore cannot reuse stale content. A matching hash returns that file's complete JSONB FileBlock without reparsing or rewriting derived SQL projections. Rules and skills may name additional global roots, each separately admitted through FileOwner. The tools target is the explicit exception: it admits the canonical `tools.schema` source rather than target-repository files. No owner may read around FileOwner or persist projected objects and relations as a second source.

### `ctx.status`

ctx cache status asks the same cache coordinator predicate used by load; it does not infer freshness from table existence. ctx cache build ensures selected owners have current FileBlock revision sets; a true forced rebuild is a separate operation. Normal owner-backed commands automatically revalidate admitted inputs, reuse matching FileBlocks immediately, or rebuild changed files and atomically publish before querying. Cache provenance is part of the runtime receipt (fresh, rebuilt, fallback, or unavailable) and must not be hidden behind a generic success state.

### `operations-call`

CLI is a thin projection of calls into stateful semantic Class Instances or named stateless APIs. Each command is a Call with the uniform shape `target.method(payload)`. Tools Schema admits and validates the input payload; the target is injected and allowlisted; ports are injected; and Handbook route readback is scoped to the command's declared module or unified service route. A call produces a bounded Result Object or evidence value without requiring an output-schema gate; output remains projection data and is not rejected merely for shape. If one result is passed to another API, it becomes that receiving API's input and is validated only at the receiving boundary. No command invents private Schema or performs arbitrary dynamic method dispatch. A call fails with an Error Object if input validation fails. Cross-module information is obtained by the caller through four separate module calls; each result remains scoped to its module and is interpreted by the caller.

## Related

[[handbook/definition]], [[handbook/modules]], [[handbook/evidence]]
