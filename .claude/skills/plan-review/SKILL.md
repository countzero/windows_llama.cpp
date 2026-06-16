---
name: plan-review
description: Second-pass review of a plan before presenting it to the user. Use when about to present a non-trivial plan in plan mode, or a multi-step implementation outline in normal/build mode (TodoWrite with 3+ non-trivial items, or a response describing edits to 2+ files). Skip for trivial / one-line changes or when the user asked for "minimal" / "quick" / "just do X" / "smallest fix". Applies ten design lenses and emits a one-line tail marker only when the pass changes the plan.
---

# Plan Review (Second Pass)

## When to fire

Fire when ALL of the following hold:

- The plan involves writing or changing code, configuration, or a structured authored artefact (Jira ticket, Confluence page, ADR, design doc).
- The plan touches more than one file, introduces a new abstraction (function, class, type, module, config key, route, schema field, table, env var), or rewrites multiple sections of one structured artefact.
- The user has not asked for a minimal / quick / smallest answer.

Fires in plan mode AND in normal/build mode (multi-file edit outlines, or `TodoWrite` with 3+ non-trivial items, count as a plan).

Skip for pure Q&A, file inspection, one-line fixes, and mechanical edits.

## Workflow

1. Draft the first-pass plan internally.
2. Walk each lens below as a single probe. Revise the plan if any probe yields a concrete removal or simplification.
3. Present the (possibly revised) plan. Append the tail marker ONLY if the second pass changed something.

## Lenses

| Lens                              | Probe                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| YAGNI                             | Anything in this plan not required by the current ticket / user request?               |
| KISS                              | Simplest version that still solves the problem? Why isn't that the plan?               |
| DRY                               | Is this knowledge already represented somewhere reusable in the codebase?              |
| SOLID                             | Any single piece with more than one reason to change? Split it.                        |
| Premature Optimization            | Adding complexity for an unmeasured perf concern?                                      |
| Occam's Razor                     | Simpler explanation of the problem that would make a smaller plan sufficient?          |
| Tesler's Conservation             | Is irreducible complexity placed in the right layer (api / service / library / client)? |
| Gall's Law                        | Starting from a working simple system and growing it, or designing complexity up front? |
| Principle of Least Astonishment   | Will the next reader be surprised by naming, dependency direction, or layering?        |
| Inversion                         | What would make this plan obviously bad? Are we close to any failure mode?             |

## Disclosure

If, and only if, the second pass changed something, append exactly one tail line to the plan, after a blank line:

```
[reviewed: <lens-1>[, <lens-2>...]] <what changed, 6-12 words>
```

Examples:

- `[reviewed: YAGNI] dropped the IRoleCache layer, only one caller`
- `[reviewed: KISS, DRY] collapsed two helpers into the existing util`
- `[reviewed: SOLID] split the orchestrator from the persistence path`

If the pass changed nothing, emit no marker. Silence is honest.

## Don't

- Don't recite the lens list in the plan body.
- Don't claim adherence ("adheres to KISS"). Either name a lens that drove a concrete change, or stay silent.
- Don't fire on trivial tasks. Most sessions don't need this.
