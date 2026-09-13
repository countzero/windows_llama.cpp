---
name: session-retrospective
description: >
  End-of-session retrospective. Use when the user asks to review the
  current session for improvement opportunities, or types
  /session-retrospective. Scans the conversation for friction and discoveries,
  classifies each candidate by destination (AGENTS.md, docs/, new
  skill, existing skill, drop), runs an adversarial gauntlet that
  kills candidates failing already-captured / counterfactual /
  generalization / triviality / process-worked tests, then presents
  only survivors interactively. Default expected count is zero.
  Single-session scope; no cross-session memory.
disable-model-invocation: true
---

# Skill: Session Retrospective

End-of-session retrospective that proposes additions to `AGENTS.md`,
`docs/`, an existing skill, or a new skill, but only when an
adversarial gauntlet has killed every candidate that does not survive
five concrete tests. Default expected output: zero additions.

## Core principle

The skill argues against itself before bothering the user. The
default-on bias of an LLM proposing documentation is to over-propose:
"plausible improvements" rather than "improvements that would have
prevented this session's friction". Without an adversarial pass the
user has to do the culling manually with a single dismissive question;
the gauntlet automates that pushback.

A finding survives only when it passes **all five** gauntlet tests.
The agent must justify each survivor *up* from zero with concrete
evidence, not *down* from a cap.

The `process-worked` test specifically asks whether an **automated**
process caught the issue, not whether the user did. Treating a human
"wait, why are you doing X?" as `process-worked` collapses the gauntlet
into "the user can override anything, so propose nothing", which is the
failure mode the core principle warns about. The user catching the
issue is evidence the issue is real, not evidence the system already
handled it.

## When to use

- The user asks for a retro of the current session.
- The user types `/session-retrospective`.

Do **not** use this skill:

- Mid-session ("we just learned X — write it down" is a normal Edit,
  not a retro).
- Across multiple sessions. Single-session scope; no friction log, no
  recurrence tracking, no cross-session memory.

## Workflow

Track the steps with `TodoWrite`. Mark each `in_progress` when
starting and `completed` when done.

1. **Resolve context.**
   - Current branch via `git branch --show-current`. This repo has no
     ticket-key convention; the branch name is the report label, with
     `/` replaced by `-`.
   - Timestamp: `Get-Date -Format "yyyyMMdd-HHmm"`.
2. **Scan session.** Walk the conversation in order. Tag every event
   that is one of:
   - **Friction:** user corrected output, asked to redo, expressed
     frustration, overrode an approach, or 3+ rounds on the same
     topic. Distinguish friction from normal iteration ("try a smaller
     ctx-size" is collaboration, not friction).
   - **Discovery:** a fact about this wrapper, the build, or a model's
     behaviour that was learned mid-session and is not yet captured.
   - **Procedure:** a multi-step playbook (3+ steps with decision
     logic) that was executed and is likely to recur.
   - **Skill gap:** a task adjacent to an existing skill where the
     skill could have helped but didn't, or didn't exist.
3. **Classify by destination** using the routing table below.
4. **Self-challenge gauntlet.** Run every candidate through all five
   tests below. A candidate survives only when it passes all five.
   Maintain a kill log throughout: every killed candidate with the
   test that killed it and, where relevant, the existing line that
   already covers the fact.
5. **Prioritize survivors.** Default expected count is **zero**. Hard
   cap **3**. Each survivor must come with a one-sentence statement
   of the future-session mistake it prevents. If that sentence cannot
   be written cleanly, the candidate goes back through the gauntlet
   and almost always dies.
6. **Read existing destinations** for each survivor to detect last-mile
   duplicates, contradictions, and the right insertion point.
7. **Present interactively, one at a time.** For each survivor:
   - Quote the session evidence.
   - Show the proposed concrete diff (exact text, exact location).
   - State the future-session mistake it prevents.
   - Ask confirm / reject / refine.
8. **Apply confirmed edits** via `Edit` / `Write`. Skip rejected ones.
9. **Write the report** to
   `.tmp/sessions/<session-id>/retro-<branch>.md`. Report shape is in
   the *Report* section below.
10. **Print the terminal output** of the turn. Exactly one of:
    - `No additions needed.` + the kill log + the report file link.
    - `N proposed addition(s).` (1–3) + the interactive presentation
      + the kill log of dropped candidates + the report file link.

    The report file link is the last thing printed. Nothing follows
    it. Any follow-up question opens a new turn.

## Routing table

| Candidate signal                                                            | Destination                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------ |
| Behavioural rule about the build, the scripts, or the repo layout           | `AGENTS.md` -> *Non-obvious behavior*                  |
| Prohibition whose violation is a silent OOM, silent corruption, or an abort | `AGENTS.md` -> *Traps*, **and** the backing `docs/` section |
| Build-script, toolchain, submodule, or vendored-path reasoning              | `docs/build_system.md`                                 |
| Cross-model INI rule (device pinning, `load-mode`, `no-host`, `fit`, context sizing, spec) | `docs/presets.md`                       |
| Per-model rationale or a measured VRAM / throughput number                  | `docs/model_tuning/<family>.md`                        |
| User-facing launch or INI-syntax instruction                                | `presets/README.md`                                    |
| 3+ step playbook with decision logic, fits an existing skill's scope        | Extend `.claude/skills/<existing>/SKILL.md`            |
| 3+ step playbook that's its own concern                                     | New `.claude/skills/<name>/SKILL.md`                   |
| Tool/MCP gap                                                                | Note in report only; no auto-edit                      |
| Session-specific minutiae unlikely to generalize                            | **Drop**; note in kill log                             |

Some rules deliberately live in more than one place. A trap is stated
in `AGENTS.md` *Traps* without rationale, in its `docs/` section with
rationale, and — where a reviewer needs it without an on-demand read —
in the `pr-code-review` *Project-Specific Review Checklist*. When a
candidate targets one of those, propose the edit to **all** copies in a
single survivor, never to one in isolation.

## Self-challenge gauntlet

A candidate survives only when it passes **all five** tests.

| Test               | Operationalized as                                                                                                                        | Kill if                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Already-captured   | Run `rg -i "<key terms>" AGENTS.md docs/ presets/README.md .claude/skills/` and `git log -p -n 20 -- AGENTS.md docs/ .claude/skills/` for in-session commits. | Any hit covers the same fact. Quote the existing line in the kill log.   |
| Counterfactual     | Locate the actual mistake event. Did the user correct a fact the agent **didn't know**, or one it **knew but lapsed on**?                  | If lapse, kill: more docs don't fix lapses.                              |
| Generalization     | Would this be equally true of any llama.cpp build, or does it depend on this Windows / MSVC / CUDA / Conda wrapper and its pinned presets? | If it holds anywhere, kill: generic llama.cpp or PowerShell knowledge.   |
| Triviality         | Can any agent derive this in <60 seconds from `--help`, the INI files, or the build script?                                               | If yes, kill: permanent context noise must clear a higher bar.           |
| Process-worked     | Did an **automated** process catch the issue *in this session*? See the scope note below — it is narrow in this repo. The user reading agent output and pushing back does NOT count. | If yes, kill: the existing automated process is the doc.                 |

**Scope note on `process-worked`.** This repo has no tests, no linter,
no type-checker and no CI (`AGENTS.md` -> *Commands*). The only automated
gates are the build itself (`rebuild_llama.cpp.ps1`), the running
build-tree-process abort, and llama.cpp's own startup validation — a
refused `cache-type` pair, an unknown `load-mode` value, a missing
template file. This test therefore kills far fewer candidates here than
in a repo with a test suite; do not stretch it to cover a human review.
Conversely, a failure mode that llama.cpp *silently* accepts is by
definition not caught by any process, and is exactly what *Traps* exists
for.

If the agent cannot identify which test a candidate would *fail*, the
candidate is not yet justified; kill it.

## Friction signals

| Signal                   | Example                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| User asks to redo        | "No, redo this", "Try again", "That's not what I meant"                |
| User corrects output     | "Actually it should be X", "Change this to Y"                          |
| User pushback            | "Is this really adding value?", "Keep it simple", "You keep doing X"   |
| Excessive back-and-forth | 3+ rounds on the same topic without resolution                         |
| User overrides approach  | "Don't do it that way", "Skip that step", "Just do X"                  |

Do **not** treat as friction:

- Normal iterative refinement.
- User exploring options.
- User changing direction (new input, not a mistake).
- A tuning loop that converges. Sweeping `ctx-size` or `fit-target`
  across several launches is the documented way this repo finds a
  number, not evidence of a problem.

## Report

Path: `.tmp/sessions/<session-id>/retro-<branch>.md`.

Create `.tmp/sessions/<session-id>/` if it does not exist. Re-running
the retro for the same branch in the same session overwrites the prior
report; that is intentional. Branch names lowercase with `/` replaced
by `-`.

Body:

```markdown
# Session Retro: <branch> (<YYYY-MM-DD HH:mm>)

## Survivors

<one block per survivor, or the line "None.">

### <destination>: <one-line title>

- **Evidence:** <quote from session>
- **Prevents:** <one-sentence future-session mistake this prevents>
- **Diff:** <exact text + exact insertion point>
- **Decision:** confirmed | rejected | refined

## Kill log

| Candidate            | Destination | Killed by         | Note                                                  |
| -------------------- | ----------- | ----------------- | ----------------------------------------------------- |
| <short title>        | <dest>      | already-captured  | Quote the existing line, or cite the file:line.       |
| <short title>        | <dest>      | counterfactual    | Agent knew the rule; lapse, not knowledge gap.        |
| <short title>        | <dest>      | generalization    | Generic <topic> knowledge.                            |
| <short title>        | <dest>      | triviality        | Derivable in <60 s from <source>.                     |
| <short title>        | <dest>      | process-worked    | Caught in-session by <process>.                       |

## Summary

<N proposed addition(s) | No additions needed.>
```

## Hard guarantees

- Never writes to `AGENTS.md` / `docs/` / `presets/` / any skill
  without explicit per-finding user confirmation.
- Never invents friction; uses only observable session evidence.
- Default expected survivor count is **zero**. Hard cap **3**.
- Kill log is mandatory output for every retro, even when zero
  candidates survive. The kill log is part of the chat output, not
  only the report file.
- Never modifies build scripts or preset INI files; docs and skills
  only. A preset value that should change is a finding to report, not
  an edit to make.
- Never commits or pushes.
- Single-session scope. No friction log, no recurrence tracking, no
  cross-session memory.
- Report files only under `.tmp/sessions/<session-id>/`. Never
  `.claude/`, the repo root, or `vendor/`.

## Constraints

- Do NOT modify source code (docs and skills only).
- Do NOT post comments, reviews, or any data to GitHub.
- Do NOT commit or push.
- Do NOT silently surface candidates that failed the gauntlet, even
  if they look interesting. The user can override a kill by name
  after seeing the kill log; the skill does not relitigate on its
  own.
