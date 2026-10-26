---
tags: [handbook, evidence, verification]
description: "What currently proves the contracts, what each proof does not establish, the known gaps, and the order in which proof is gathered."
version: 6
---

# Evidence

## What

Evidence is bounded and typed. A passing test proves the behavior it tests, not the whole contract. A schema check proves shape, not runtime use. A gate proves the invariant it encodes, not the architecture around it. A document review proves representation, not truth. This note records what proves each claim, and what that proof does not establish.

## What is proved today

Checks that depended on the retired handbook module are red or stale; see [Known gaps](#known-gaps). The table below states what each check is meant to prove, not that it currently passes. A named check is the evidence source, not a procedure to follow; what may be asserted and how a check is run belongs to the owning skill.

| Claim | Proof | What it does not establish |
| --- | --- | --- |
| The seven public `target.method` contracts accept and return their declared shapes, and retired routes are rejected | `npm run test:contract`, which runs `test/public-target-method-contract.test.mjs` through `scripts/test-runner.mjs` | Anything about internal state, call order, cache decisions, or service internals — those are deliberately not test points |
| The FileBlock ground-model boundary holds | `npm run gate:fileblock-ground-model` via `scripts/check-fileblock-ground-model-boundary.mjs` | That every owner publishes correct FileBlocks |
| Cross-repository boundary rules hold | `npm run gate:cross-repo-boundary` via `scripts/check-cross-repo-boundary.mjs` | Behavior of a repository that has not been exercised |
| Handbook notes follow the Markdown format of [[handbook/README]] (three properties, integer version, resolving wikilinks, non-empty body, every chapter linked) | `npm run gate:architecture` via `scripts/check-architecture-contract.mjs` | That the notes are correct, or that they agree with source; the gate reads structure, not meaning |
| The configuration contract and its runtime agreement hold | `npm run gate:config` and `npm run gate:config-schema-runtime` | Anything outside the configured surface |
| Repo skills reference real sources and configuration | `npm run gate:skill-source-config` | Skill procedural quality |
| Lint baseline holds | `npm run lint` through `eslint-config-airbnb-extended` | Correctness |
| The CLI surface renders the seven entries | `npm run smoke`, plus reading the actual `--help` output | Behavior behind each entry. An emitted JSON result is not proven machine-readable until it has been parsed. |

## Proof boundary

How a check is run, and what may be asserted, is owned by the responsible procedure, not by this handbook:

- `.claude/skills/test-system/SKILL.md` owns durable public contract proof. The only durable product test boundary is `target.method` input and output, exercised through actual CLI invocation, and the current lane is `npm run test:contract`. It also owns which internal state, cache decision, debug output, and call order must never become a test point.
- `.claude/skills/ctx-self-bootstrap/SKILL.md` owns the before-and-after comparison between an independent static view and a product view.
- `.claude/skills/code-review/SKILL.md` owns the review pass after a bounded change.

This handbook states which claim needs which evidence and what that evidence does not establish. It does not restate a procedure, a command sequence, or an assertion policy; those belong to the owning skill, and duplicating them here would create a second truth that can drift.

## Known gaps

These are open and are recorded so they are not mistaken for proof.

- **The XML handbook runtime module is disabled; the gates that depended on it were replaced.** `ctx handbook` no longer reads this directory and reports a maintenance status. `npm run gate:architecture` now checks the Markdown notes against the format in [[handbook/README]]; `gate:skill-source-config` checks that the index and contract notes exist and runs the skill end-to-end test; `gate:cross-repo-boundary` probes `codebase search` in place of the retired `find`. All six gates pass on 2026-10-26, and `npm run test:contract` passes 27 cases in 8 files. ADR-008 in [[handbook/decisions]] withdraws the plan to rewrite the module as a persisted carrier. These gates read structure; they do not prove the retired runtime or the meaning of a note.
- **`WorldMap` is required but not wired to the current views.** `AGENTS.md` and `.claude/skills/ctx-kernel-architecture/SKILL.md` require every relation-oriented view to carry a `WorldMap`. `codebase/projection/world-map.mjs` builds it, but its only callers were in the retired `ctx pack` command (`product-context-command.mjs`, present at `d6985d2`); `contain`, `call`, `dep`, `data`, `seq`, and `relate` never called it. Wiring needs a decision on which projection rows each view hands to the adapter, so those results are navigation evidence without the envelope until then.
- **The retired architecture gate accepted empty content.** `scripts/check-architecture-contract.mjs` required a non-null `structure.content` for each of its nine required blocks, but an empty string is not null. Six of those nine blocks were empty shells, so the gate was passing on blocks that carried no meaning. The replacement gate treats an empty note body as a failure.
- **The former pre-read gate was vacuous.** Before this change, the mandatory handbook pre-read named five unit blocks, of which `operations-grammar`, `operations-development-pipeline`, `coding-style`, and `evidence-testing` resolved to blocks with empty content. The command returned `count` 5 and an empty body for those, so the gate passed without carrying meaning. Any future gate that selects by identifier must fail closed on an empty body rather than treat presence as content.
- **Handbook regression coverage is thin.** The retired unit-block behavior had no dedicated permanent test lane after the CLI refactoring. A rewrite of the handbook module should add coverage for selection, statistics, export, tree, duplicate identifiers, malformed input, and a missing or wrong-case index.

## Related

[[handbook/contract]], [[handbook/flow]], [[handbook/decisions]]
