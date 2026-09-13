# Conventions Reference

Read when writing a commit message, a pull request description, a `.ps1` comment, or a
paragraph in `AGENTS.md`, `docs/` or a README. Not auto-loaded into the agent context; read
it on demand. The one-line rules these sections back are in AGENTS.md "Version Control" and
"Documentation and prose"; the changelog bullet format is AGENTS.md "Changelog style" and is
not repeated here.

## Commit messages

The subject is **one imperative line** naming what changed and what it replaces: `Move the
Qwen3.8-27B projector to CUDA0 instead of running CLIP on the CPU`. No type prefix, no
ticket key, no trailing period, no column target: say the thing, and if that takes ninety
characters it takes ninety characters.

The body wraps at 80 columns and carries **everything the diff cannot show**:

- **The measurement.** A preset or build change that claims a win states the hardware, the
  llama.cpp build, the prompt or probe, and both numbers. "Faster" without a figure is not a
  claim anyone can check a year later.
- **The rationale**, including the mechanism where one was found: the upstream file and line
  that makes the flag behave the way it does, the allocator behavior behind a slowdown.
- **The alternatives that were tried and dropped**, with why. A rejected approach is the
  most expensive thing in a session and the easiest to re-attempt.
- **What was deliberately left undone**: the entry that was not retuned because it was not
  measured, the submodule pin that still wants its own commit, the figure that is now stale.

No `Co-Authored-By`, no `Generated with`, no `Signed-off-by` trailer.

A commit that changes behavior carries its own `CHANGELOG.md` version entry **in the same
commit**. Versions are bumped per change; there is no release branch that collects them
afterwards, and a change with no changelog entry is invisible to everyone who was not in the
session.

## Pull request descriptions

Work lands on `develop`. `main` receives it only through a pull request, titled
`Release vX.Y.Z` when it carries a batch of them and descriptively when it carries one
change. An outside contributor opens theirs from a fork against `main`.

A description answers two questions, both mandatory:

- **What** changed, specifically enough to skim: not "fix the presets" but which entry moved
  and which key moved on it.
- **Why**, including the context you had as the author and the decisions the diff cannot
  show. Do not assume the reader knows the history.

Three things are easy to omit and are the ones a reviewer needs most:

- **The shortcomings of the approach.** Every non-trivial change has them. Naming them is
  what separates a description from a sales pitch, and it points the review at where it is
  worth most.
- **Which feedback you want**, and on what. "Sanity-check the VRAM headroom" and "argue with
  the tier this entry landed in" ask for different reads.
- **What is not done**: an unrun rebuild, an entry left on the old value, a measurement
  taken under sampling that has since changed. A draft says so in its state; everything else
  says so in the body.

Write it to survive. A link to an upstream issue, a CI run or a benchmark log rots or
outlives the system it points at, so a link supplements the description and never carries
it. A change to a document additionally names what it replaces (*Documentation*).

There is deliberately **no `PULL_REQUEST_TEMPLATE`**, and none is to be added. A template
prompts for headings, and the headings are the part that legitimately varies between a
preset retune, a build-flag change and a documentation split; what does not vary is the
substance above, which no template can check.

A **release** pull request groups its account by the area a change belongs to, using the
same component tags the changelog uses (`[Build]`, `[Presets]`, `[Documentation]`,
`[Examples]`), and leaves out the ones with nothing in them. It opens with two to four
sentences naming the work that carries the release and anything that makes adopting it more
than a rebuild: a preset key that changed meaning, a build flag that must be re-run, a
submodule pin that moved. Each change is one line opening with a past-tense verb.

The two questions, the shortcomings and the link that carries nothing are Google's
[Writing good CL descriptions](https://google.github.io/eng-practices/review/developer/cl-descriptions.html);
the feedback you ask for, the draft state and not assuming the reader knows the history are
GitHub's
[How to write the perfect pull request](https://github.blog/developer-skills/github/how-to-write-the-perfect-pull-request/).

## Documentation

Every piece of information has exactly one home, chosen by its **kind**, not by its topic:

| Kind of information                      | Home                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| A rule that fires in every session       | `AGENTS.md`: one invariant per area, one or two sentences, ending in a pointer          |
| A prohibition with a silent failure      | `AGENTS.md` "Traps", stated without rationale, projected from the `docs/` file          |
| A contract, its mechanics, its numbers   | The reference document of that task, listed in `AGENTS.md` "Reference"                  |
| A decision and its rejected alternatives | The commit message that made it                                                         |
| A recipe an agent runs with tools        | A skill under `.claude/skills/`, which points at the document rather than restating it  |
| What shipped in which version            | `CHANGELOG.md`, one bullet per change                                                   |
| A value that changes on its own          | Nowhere. Point at the file that sets it: `requirements_override.txt`, `.env.example`    |
| The history of this repository           | Git, never a document                                                                   |
| A rule that already has a home           | A pointer: `` `docs/<file>.md` -> *Section* ``                                          |

Three refinements the table cannot carry:

- **A procedure keeps its commands, and a contract keeps its values.** The command a
  procedure needs and a configured value together with the reason it has one are content of
  the document that owns them, written once. What stays out is the value nobody reasons
  about, which a reader looks up in the file that sets it.
- **An invariant is not a summary.** `AGENTS.md` names the rule and where it lives; the
  exceptions, the mechanics and the reasoning stay in the reference document. When a bullet
  in `AGENTS.md` grows a sub-list, the sub-list is the contract and belongs in `docs/`.
- **A measured number belongs to the document that owns the mechanism**, and it carries the
  conditions it was measured under. A number quoted in a second place drifts silently,
  because only one of the two copies is re-measured after a retune.

### Size budgets

Measured in bytes. The target is where a split is planned; the limit is what no change may
push a document over. Both are checked by a person; there is deliberately no gate.

| Kind of document                       | Target       | Limit  |
| -------------------------------------- | ------------ | ------ |
| `AGENTS.md`, loaded into every session | about 12,000 | 16,000 |
| A reference document under `docs/`     | about 30,000 | 45,000 |

Above the limit a reader searches instead of reading, misses the rule that is already there,
and writes it a second time; that is where duplicated rules come from. A document near its
target is split **by the task its reader is doing**, not by topic size: a reader tuning one
model opens the one file under `docs/model_tuning/` that names its family, and the rules
that hold across all of them sit in `docs/presets.md` instead of in each of them.

### Pointers and shape

A rule is stated once and appears everywhere else as `` `docs/<file>.md` -> *Section* ``,
naming the document and the heading. Section names are therefore an interface: a section
that is pointed at is a heading, not a bold paragraph lead, and renaming or moving one means
re-pointing every caller across the repository, hidden directories included:

```powershell
Get-ChildItem -Recurse -Force -Include *.md, *.ps1 |
    Where-Object { $_.FullName -notmatch '\\vendor\\|\\node_modules\\' } |
    Select-String -SimpleMatch "Section name"
```

- One H1, then one sentence saying who reads the document when, identical to its cell in
  `AGENTS.md` "Reference".
- snake_case file names, named after the task.
- Prose wraps at about 100 columns. A table row and a changelog bullet stay on **one physical
  line** regardless of length; never hard-break one.
- An addition names, in the commit message, what it replaces, or why nothing did. Behavior
  that is taken back loses its prose in the same commit: a document never describes what the
  scripts no longer do.

## Punctuation and tables

The em dash is reserved for interrupted dialogue and a genuine break in the flow of thought.
Everywhere else, reach for the more specific mark: paired commas for a short aside bound to
the sentence, parentheses for a tangential one, a colon to introduce an explanation or list,
a semicolon or a full stop to join two related independent clauses, an en dash for a numeric
or date range, and a hyphen for a compound modifier. The urge to reach for an em dash
normally signals a poorly structured sentence, and rewriting is always allowed.

Do not mechanically strip em dashes. If the em dash is the right mark, keep it. The existing
prose in this repository is mixed; correct it in the paragraphs you touch, never in a sweep.

Pad every cell of a markdown table, header and separator row included, so all cells of a
column share one width. The one exception is a final column holding a paragraph, as in the
Reference table of `AGENTS.md`: pad the columns before it and leave that one ragged, because
a 350-character pad helps no reader and has to be redone across every row on the next edit.

## Comments

Comments explain **why**, not **what**. The code already states what it does; a comment that
restates it is noise that drifts out of sync.

- **Default to no comment.** Reach for a clearer variable name or a smaller function first.
  Comment only when the reason is non-obvious from the code.
- **One home per rationale.** A `.ps1` comment states the reason once at the line that needs
  it and otherwise points: the mechanism lives in the matching `docs/` file, the decision in
  the commit message. Do not repeat an explanation at every consumer.
- **No history in a comment.** No date, no "was 16 before", no account of what a previous
  version did. `git blame` carries that and stays correct.
- **Length is a smell.** A why-comment over about three lines usually signals unclear code;
  fix the code first. Reserve longer blocks for a genuinely subtle invariant at its single
  source of truth, such as why a patch step must run after the checkout.

Comment-based help (`<# .SYNOPSIS ... #>`) is documentation rather than a comment and is
exempt: it is the `Get-Help` surface of a script a user runs directly, and it is expected to
restate what the parameters do.

## PowerShell and CLI style

- **Full cmdlet names, never aliases.** `Get-ChildItem`, not `gci` or `ls`; `Where-Object`,
  not `?`. An alias resolves differently between PowerShell editions and shells.
- **Long-form parameters** in scripts, README examples and documentation, for this
  repository's own scripts and for every native tool that offers them: `--header` not `-H`,
  `--message` not `-m`. Short forms stay acceptable where no long form is common.
- **`-LiteralPath` rather than `-Path`** whenever a path may contain `[`, `]` or `` ` ``,
  which model file names regularly do.
- **Check `$LASTEXITCODE` after every native call that matters.** PowerShell does not stop on
  a non-zero exit from a native executable, so a failed `cmake --build` falls through to the
  next step and the script reports success while the previous build's binaries are still in
  `bin/Release/`. Both `cmake` steps in `rebuild_llama.cpp.ps1` check it for this reason.
- **A script a user runs directly carries comment-based help.** `server.ps1`,
  `speed-bench.ps1` and `count_tokens.ps1` do; a new one in `examples/` is expected to.
