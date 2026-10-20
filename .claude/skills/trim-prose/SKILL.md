---
name: trim-prose
description: >
  Editing pass over the comments and documents a branch adds or changes. Cuts
  history lessons, the route to a decision, meta-commentary and the obvious,
  keeps the failure mode a rule prevents, and reports the lines and words
  removed. Use when asked to go through, tighten, shorten, or re-read the
  updated comments and docs of a branch, before opening a pull request whose
  prose has not been re-read, or when the user types /trim-prose. Edits the
  working tree; never commits.
---

# Trim Prose

The rules have homes and are not restated here: `docs/conventions.md` ->
*Comments* holds what a comment is for, *Documentation* where a piece of
information lives and the size budgets, *Punctuation and tables* the em dash
and the table padding. This is the recipe for applying them to one branch's
diff in one pass.

## Running the blocks

The blocks below are bash. The session shell is PowerShell, and the `bash.exe`
first on its PATH is WSL's, which sees another filesystem. Write each block
with the Write tool to `.tmp/sessions/<session-id>/trim/<name>.sh` and run it
with Git Bash from the repository root:

```powershell
& 'C:\Program Files\Git\bin\bash.exe' ".tmp/sessions/<session-id>/trim/<name>.sh"
```

Under OpenCode `<session-id>` is `$env:OPENCODE_SESSION_ID` in the PowerShell
line and `$OPENCODE_SESSION_ID` inside a block, which Git Bash
inherits; under Claude Code write the literal id (`AGENTS.md` -> *Scratch
Files*). Every block opens with the same two lines, so no variable has to
outlive the call that set it:

```bash
MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)") || exit 1
SCRATCH="$MAIN/.tmp/sessions/<session-id>/trim"; mkdir -p "$SCRATCH"
```

`--git-common-dir` names the main repository's `.git` from a linked worktree
too, so the scratch stays in the main tree's `.tmp/` and survives the
worktree's removal (`docs/worktrees.md` -> *Scratch artefacts*).

## Scope

Read the branch's own prose, committed and uncommitted:

```bash
# prelude
git fetch origin
BASE=$(git merge-base origin/develop HEAD) || exit 1
[ -n "$BASE" ] || exit 1                     # empty reads as an ordinary diff
printf '%s\n' "$BASE" > "$SCRATCH/base"
git stash create > "$SCRATCH/pre"            # a commit object; the tree is untouched
[ -s "$SCRATCH/pre" ] || git rev-parse HEAD > "$SCRATCH/pre"
git diff "$BASE" --stat
git diff --stat
git ls-files --others --exclude-standard     # git diff never shows these
```

Then record what the tree held, so *Prove* can show the pass touched nothing it
did not mean to:

```bash
# prelude
ROOT=$(git rev-parse --show-toplevel) || exit 1
[ -n "$ROOT" ] || exit 1                        # an empty ROOT makes it all vacuous
printf '%s\n' "$ROOT" > "$SCRATCH/root"         # Prove reads this back, never re-derives
{ git -C "$ROOT" diff HEAD --name-only -z
  git -C "$ROOT" ls-files --others --exclude-standard -z; } |
  sort -zu > "$SCRATCH/dirty-before"
c=0
while IFS= read -r -d '' f; do
  c=$((c+1))
  if [ -e "$ROOT/$f" ]; then printf '%s %s\0' "$(git hash-object --no-filters -- "$ROOT/$f")" "$f"
  else printf 'absent %s\0' "$f"; fi
done < "$SCRATCH/dirty-before" > "$SCRATCH/digests-before"
printf '%s\n' "$c" > "$SCRATCH/digests-count"   # a path may hold a newline: count here
```

`# prelude` stands for the two lines under *Running the blocks*.

`git stash create` records the tree as the pass found it without touching a
single file, and *Report* diffs against it so the counts describe this pass
rather than everything uncommitted in the tree.

The `ls-files` line is not redundant. An untracked file appears in no diff, so a
document the branch added and has not staged, the likeliest home there is for a
history lesson, would go unread and the pass would report itself clean. Read
each one whole: every line of a new file is an added line.

The records are NUL-terminated because a newline-terminated record splits in
two where a path holds a newline, so an undisturbed tree would report `moved:`
twice; the count is taken from the loop rather than from the file so that it
cannot agree with the corruption.

**Uncommitted prose may not be yours.** This pass edits a working tree other
agents share, and *Scope* deliberately reaches into exactly the uncommitted
files where their work in progress lives (`docs/conventions.md` -> *Shared
working tree*). Before editing a dirty file, establish whose the dirty hunks
are; a file carrying both your findings and someone else's edits stops the
pass and goes to the user. Re-wrapping a paragraph around a foreign sentence is
a change that author never asked for and cannot easily unpick.

Then read the **added lines**, not the files:

```bash
# prelude
git diff "$(cat "$SCRATCH/base")" -U0 | grep -E '^(@@|\+)'
```

`+++ b/<path>` and `@@` survive that filter on purpose: without them a struck
phrase cannot be located again, and *Report* wants every finding anchored to
where it was found.

In scope: a `+` line after `#` or inside `<# #>` in a `.ps1`, a `;` or `#`
comment in a preset `.ini`, a `//` or `/** */` in a `.js`/`.mjs`/`.py`; every
`.md`, `README.md`, `SKILL.md`. Out of scope: code, identifiers, parameter
names, `CHANGELOG.md`, everything under `vendor/`, and `.env`, which is never
opened. Comment-based help (`<# .SYNOPSIS #>`) is in scope but is held to
`docs/conventions.md` -> *Comments*, which exempts it from the why-not-what
rule: it is expected to say what a parameter does.

## Cut

Each category is a test with a yes/no answer. A sentence that is merely long is
not a finding.

| Cut                   | The test                                                                     |
| --------------------- | ---------------------------------------------------------------------------- |
| History lesson        | Does it say what the code, the file or the rule **used to** be?              |
| Route to the decision | Does it narrate how the decision was reached instead of stating it?          |
| Meta-commentary       | Is the subject the prose itself rather than the thing it describes?          |
| The obvious           | Would the code beside it, or the sentence before it, already say so?         |
| Second copy           | Does this rationale already have an authoritative home?                      |
| Inventory or version  | Is it a count, a list or a version the file system or the setting file holds? |

A *second copy* is replaced by a pointer, `` `docs/<file>.md` -> *Section* ``,
never deleted outright. An *inventory* goes when nobody reasons about the
number ("the six presets"); a value a reader reasons about stays.

## Keep

Cutting these is the failure mode of this pass:

- **The failure mode a rule prevents.** "Below ~300 MiB WDDM pages the working
  set to system RAM and the entry silently runs 20-45 % slower" is the reason
  the margin rule exists, and the reader cannot re-derive it.
- **A measured number with its conditions**, in the document that owns the
  mechanism (`docs/conventions.md` -> *Documentation*).
- **A constraint from outside the repository**: an upstream llama.cpp
  behavior, a CUDA or WDDM limit, a PowerShell quirk.
- **The one authoritative statement** of a rationale, at its definition,
  however long it has to be.
- **The deliberate projections.** A line of `AGENTS.md` -> *Traps* and the
  reviewer brief's *Project checklist* (`.claude/skills/pr-audit/prompts/reviewer.md`)
  restate a `docs/` rule on purpose; they are not second copies.

## Verify

Before reporting, from the repository root:

```bash
# prelude
LC_ALL=C wc -c AGENTS.md docs/*.md docs/model_tuning/*.md
```

Sizes against `docs/conventions.md` -> *Size budgets*. For every `.ps1` whose
comments the pass edited, check that it still parses; a stray `#>` ends a help
block early:

```powershell
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path <file>), [ref] $null, [ref] $errors) | Out-Null
$errors
```

Re-wrap every paragraph touched to the width the file already uses; a
half-rewrapped paragraph is a larger diff than the edit inside it. Say plainly
when a command fails for a reason the pass did not cause.

## Report

The counts, because a pass that changed nothing should be visible as such:

```bash
# prelude
PRE=$(cat "$SCRATCH/pre")                    # the tree as this pass found it
git diff "$PRE" --numstat | awk '{a+=$1; d+=$2} END {print a, d}'
git diff "$PRE" -U0 --output-indicator-old='<' | grep '^<' | sed 's/^<//' | wc -w
git diff "$PRE" -U0 --output-indicator-new='>' | grep '^>' | sed 's/^>//' | wc -w
```

Every count is against *Scope*'s snapshot, not a bare `git diff`, which would
credit this pass with whatever was already uncommitted when it started. The
third line is the added-word figure the net column needs. Edits to an
**untracked** file appear in no diff at all, so count those by reading the file.

`--output-indicator-old` re-marks the deleted lines and leaves the
`--- a/<path>` header as it is: filtering that header out by pattern would take
every deleted line beginning `--` with it, a front-matter delimiter or a
horizontal rule, and the files this pass edits most open with `---`.

Present one table (deleted, added, net for lines and words), then the findings
grouped by cut category, each with the struck phrase. Most deleted lines are
rewrites, so the net figure is the real reduction.

## Prove

Before reporting, from the repository root:

```bash
# prelude
ROOT=$(cat "$SCRATCH/root" 2>/dev/null); n=0
{ [ -n "$ROOT" ] && [ -r "$SCRATCH/digests-count" ]; } ||
  echo "PROOF INCOMPLETE: no capture ran"
cat "$SCRATCH/edited-by-hand" > "$SCRATCH/edited" 2>/dev/null || : > "$SCRATCH/edited"
while IFS= read -r -d '' rec; do
  n=$((n+1)); h=${rec%% *}; f=${rec#* }
  grep -qxF "$f" "$SCRATCH/edited" && continue  # an edit this pass made on purpose
  if [ "$h" = absent ]; then [ -e "$ROOT/$f" ] && echo "reappeared: $f"
  elif [ "$(git hash-object --no-filters -- "$ROOT/$f")" != "$h" ]; then echo "moved: $f"; fi
done < "$SCRATCH/digests-before"
[ "$n" = "$(cat "$SCRATCH/digests-count" 2>/dev/null)" ] || echo "PROOF INCOMPLETE: $n"
:
```

Those digests cover only what was dirty or untracked when the pass started. A
file that was committed and clean is in no record at all, so a second block
measures the whole tree against *Scope*'s snapshot:

```bash
# prelude
ROOT=$(cat "$SCRATCH/root" 2>/dev/null)
{ [ -n "$ROOT" ] && [ -r "$SCRATCH/pre" ]; } || echo "PROOF INCOMPLETE: no snapshot"
[ -r "$SCRATCH/edited" ] || : > "$SCRATCH/edited"   # the block above writes it
git -C "$ROOT" diff "$(cat "$SCRATCH/pre")" --name-only -z |
  while IFS= read -r -d '' f; do
    grep -qxF "$f" "$SCRATCH/edited" || echo "undeclared: $f"
  done
:                                               # must print nothing
```

**Append every file you edit to `$SCRATCH/edited-by-hand`**, one root-relative
path per line in forward slashes, as you edit it. Both blocks read it, and it
is the only thing that separates an edit this pass chose from damage it did
not. A file edited but never written down is reported, `undeclared:` here and
`moved:` above, which is a false alarm the user sees; that is the direction
this proof has to fail in.

Silence is the pass. A name here is a file whose bytes moved without this pass
choosing to edit it. `reappeared:` is a file that was deleted when the pass
started and is back.

- **`-z`** keeps a non-ASCII name comparable to the hand-written list; without
  it git C-quotes the name and every umlaut file reads as damage.
- **An untracked file** is in no snapshot, since `git stash create` does not
  record them, so it is the digests that hold a new document to account.
- **`$ROOT` is read back, not re-derived**, because `--show-toplevel` answers
  for whatever directory the call starts in; a pass that ended up in a
  worktree would otherwise compare that tree against the shared tree's
  digests and find every record `absent`.
- **The count file** separates a capture that never ran from one that found
  a clean tree; without it an errored capture and a comparator that read
  nothing agree on `0 = 0`.
- **`--no-filters`** makes the digest a byte comparison. Through
  `core.autocrlf` a file whose line endings the pass rewrote would hash to the
  digest it started with.

## Don't

- Don't rewrite a passage no category above caught.
- Don't edit a file whose dirty hunks are not yours, and don't re-wrap a
  paragraph around a foreign sentence; hand the file to the user instead.
- Don't touch code, identifiers or parameter names; a rename is a different ask.
- Don't strip em dashes mechanically (`docs/conventions.md` -> *Punctuation
  and tables*).
- Don't commit or push.
- Don't report a pass whose *Prove* printed a name; that is a file this pass
  damaged, not a finding to write up.
