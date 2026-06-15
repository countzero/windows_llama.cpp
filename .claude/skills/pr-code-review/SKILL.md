---
name: pr-code-review
description: >
  Multi-pass PR code review. Use when reviewing pull request code changes for
  defects and design issues. Performs 3 review passes with escalating focus,
  deduplicates findings, and produces a severity-filtered summary with deep
  links to the relevant code on GitHub, and writes the report as both
  Markdown and GitHub-styled HTML to `.tmp/sessions/<session-id>/`. This
  skill never writes comments, reviews, or any data to GitHub; it is
  advisory only.
---

## Multi-Pass PR Code Review

This skill performs 3 iterative review passes over a pull request diff with
escalating focus: general defects, cross-file interactions, then absent
behavior. After all passes, a final summary deduplicates, validates, assigns
severity, and filters to Critical/High/Medium. The output includes clickable
deep links to the relevant code on GitHub so the developer or reviewer can
easily navigate to each finding.

### PR and Diff Resolution

1. Run `gh pr view --json number,baseRefName,state,isDraft`. This single call
   determines whether a PR exists and, if so, its state.
2. **If a PR exists:**
   - If the PR is closed or a draft, inform the user and stop.
   - Otherwise, use the PR's `baseRefName` as the base for the diff.
3. **If no PR exists** (the command fails):
   - Use `main` as the default base branch (the repo's mainline; feature work
     and `develop` are PR'd into it).
   - Inform the user: "No PR found. Diffing against `main`."
4. Get the diff via `git diff <base>...HEAD`.
5. Resolve the full HEAD SHA via `git rev-parse HEAD`.
6. Resolve the repository owner/name via `gh repo view --json owner,name`
   (fall back to parsing `git remote get-url origin` if `gh` is unavailable).
   Store the owner, repo name, full SHA, and PR number (or `null` when no
   PR exists) for constructing deep links in the output.

### Context Gathering

Before starting the review passes, gather context to understand the intent
behind the changes:

1. **Branch and commits:** Read the current branch name via
   `git branch --show-current` and the commit subjects in range via
   `git log --oneline <base>..HEAD` to understand the stated intent.
2. **Full file reads:** Do NOT read full files upfront. Instead, during each
   pass, if a diff hunk lacks sufficient surrounding context to assess a
   potential defect, read the full file at that point using the Read tool.

### Design Review (before passes)

After gathering context and the diff, but before starting the defect passes,
evaluate the overall design of the change:

1. **Scope:** Does the PR implement more or less than its stated intent (branch
   name, commit subjects)? Flag scope creep or missing pieces.
2. **Placement:** Do the changes live in the correct layer? This repo is a
   PowerShell wrapper: build/orchestration logic belongs in `*.ps1` at the repo
   root or `examples/`; model configuration belongs in `presets/*.ini`;
   no original C/C++/Python source belongs here, and nothing under
   `vendor/llama.cpp/` is expected to persist (each rebuild wipes it).
3. **Complexity:** Is any part of the change more complex than necessary? Flag
   over-engineering, unnecessary abstractions, or functionality that is not
   required by the change's intent.

Record design-level findings separately under `### Design` in the output,
before the severity tables. Design findings do not go through the severity
classification; they are qualitative observations for the author.

### Workflow and User Communication

Use the TodoWrite tool to create and track these steps:

1. Resolve PR, base branch, and gather context
2. Design review
3. Pass 1
4. Pass 2
5. Pass 3
6. Build final summary (deduplicate, re-examine, severity, filter); internally only
7. Write Markdown report to `.tmp/sessions/<session-id>/`
8. Render HTML report next to the Markdown file
9. Print full report body in chat (title, metadata table, Design, severity tables), ending with the file-links trailer

Mark each todo as `in_progress` when starting and `completed` when done.
After each pass, tell the user in one line how many new defects were found
(e.g., "Pass 1 complete; found 6 defects.").

After Pass 3, build the final summary internally; **do not print it yet**.
Write the Markdown report file, then render the HTML sibling. Only after both
files are on disk, print the report body in the conversation. The chat body
matches the Markdown file body byte-for-byte except for the YAML front matter,
which lives only in the Markdown file. The **very last** content printed is a
file-links trailer (`**Report files:**` with markdown links to `file://` URIs
of the artifacts). **Nothing (no recap, no "Let me know if…", no "Review
complete" line, no follow-up commentary) may be printed after the trailer.**
The trailer is the terminal output of the turn; any follow-up question opens
a new turn.

### Review Passes

Three passes over the full diff, each with a different focus. All passes
review the full diff. Findings are recorded **without severity**: just File,
Line(s), and Description.

Only flag defects in lines that are added or modified in this PR. Do not flag
issues in unchanged context lines, even if they appear in diff hunks.

Skip any finding that:
- Matches a finding from a previous pass (same file and overlapping line
  range).
- Describes the same logical issue as an existing finding but references a
  different location (e.g., a function definition vs. its call site). Two
  findings about the same root cause count as one; keep the one closest to
  the root cause.

**Pass 1: General scan**
Review the diff. Report all defects: bugs, logic errors, security issues, bad
practices, missing validation, incorrect error handling. Also check the
project-specific concerns listed in the Project-Specific Review Checklist
section below. Only flag defects in lines that are added or modified in this PR.

**Pass 2: What was missed**
Review the diff again, assuming defects were missed on the first pass. Focus
on interactions between changed files, subtle logic errors, and implicit
assumptions in the code. Only flag defects in lines that are added or modified
in this PR.

**Pass 3: What the code does NOT do**
Assume there are still undiscovered defects. Focus on what is absent: missing
error handling, missing edge cases, missing input validation, missing null
checks, race conditions, resource leaks, and incorrect assumptions about
state. Only flag defects in lines that are added or modified in this PR.

Track findings internally across passes (in conversation context). The format
for each finding is: File, Line(s), Description.

### False Positive Exclusion List

Do NOT flag any of the following:

- Pre-existing issues not introduced in this PR's changes.
- Code that appears to be a bug but is actually correct.
- Pedantic nitpicks that a senior engineer would not flag.
- General code quality concerns unless explicitly required in AGENTS.md.
- Issues explicitly silenced in code (e.g., via a lint ignore comment).
- Pure code style or formatting preferences.
- Potential issues that depend on specific inputs or runtime state.
- Findings inside `vendor/` (the submodule is wiped and re-checked-out each
  rebuild; only the documented idempotent CMakeLists shim is sanctioned).

### Project-Specific Review Checklist

These are architectural and safety concerns specific to this PowerShell wrapper
around llama.cpp; there is no linter to catch them. Check for these during all
passes, in addition to general defect scanning. They are NOT style issues; they
are correctness and safety rules. Each maps to a rule in AGENTS.md
("Non-obvious behavior", "Presets", "Changelog style").

- **Ephemeral submodule edits:** Changes under `vendor/llama.cpp/` that expect
  to persist. Each `rebuild_llama.cpp.ps1` resets the submodule to
  `origin/master` and re-checks-out; the only sanctioned edit is the idempotent
  OpenBLAS `CMakeLists.txt` shim the build re-applies.
- **Submodule "cleanup":** Removing `.gitmodules` `ignore = dirty`, or resetting
  the `vendor/llama.cpp` pointer casually. The dirty state is by design.
- **PowerShell argument passing:** Values that can contain spaces routed through
  an `Invoke-Expression`-built command string or the `-additionalArguments`
  whitespace-split/re-pair parser (they will not survive); unquoted
  space-bearing paths in `llama-server`/`python` invocations.
- **CWD-relative path assumptions:** `chat-template-file` and `read_file()`
  resolve against the launch CWD, not the INI directory. Scripts that shell out
  to vendored Python (`gguf_dump.py`, `speed_bench.py`) must guard the path
  against upstream relocation.
- **Build-detection invariants:** CUDA is selected only when *both* `nvidia-smi`
  and `nvcc` are present; do not drop `-DCMAKE_ASM_COMPILER=ml64` (CMP0194 ASM
  breakage); do not defeat the SMT-aware `--parallel` cap or the
  running-build-tree-process abort.
- **Python requirements layering:** Edits to `requirements_override.txt` that
  break the documented `torch` (cu126), `transformers`, `numpy<2.3`, or
  `tiktoken` pins.
- **Preset INI semantics:** `mmproj-offload = true` silently OOMing CLIP warmup
  on a saturated GPU; dropping a required `chat-template-file` pin (it replaces
  the GGUF-embedded template, not redundant with `jinja = true`); stale
  `spec-type` flag names.
- **CHANGELOG style:** Entries that are not one physical line, omit the
  `[Component] <verb> <thing>` form, or carry rationale/paths/line numbers.

### Final Summary

After Pass 3:

1. **Deduplicate:** Two findings are duplicates if they reference the same
   file and overlapping line ranges, or if they describe the same root cause
   at different locations. Keep the more detailed description.
2. **Re-examine:** For each remaining finding, verify it against the full file
   context. If the file was not already read during a pass, read it now using
   the Read tool. Remove any finding that cannot be confirmed after
   re-examination.
3. **Confidence filter:** Remove any finding where confidence is below 80%
   that it is a real defect. When in doubt, exclude.
4. **Assign severity** using these definitions:
   - **Critical:** Data loss, security breach, corruption of state, a build
     that destroys a working tree, or a crash on a common path.
   - **High:** Incorrect behavior under normal usage, unhandled error paths
     that will be hit, significant logic flaw.
   - **Medium:** Bad practice that could lead to bugs, missing validation for
     unlikely but possible inputs, minor logic issue.
5. **Filter:** Keep only Critical, High, and Medium.
6. **Hold for output:** Keep the deduped, severity-filtered findings in
   memory. Do not print them yet; printing happens after the disk write per
   *Output Files* below. When the filtered set is empty, the chat body prints
   a single line `No Critical/High/Medium findings.` in place of the severity
   tables; the Design section and the trailer still print normally. When the
   set is non-empty, print one table per severity level (omitting empty
   levels), following the link format rules in the Link Format section below.

No data is written to GitHub. The developer or reviewer uses the output to
manually create PR comments.

### Output Files

Before printing anything to the conversation, persist the report to disk
under `.tmp/sessions/<session-id>/` (gitignored per AGENTS.md *Scratch Files*
rules; `<session-id>` is `SESSION_ID` when injected, otherwise a minted
`YYYYMMDD-HHMMSS-<random6>`). Always write both a Markdown file and a
GitHub-styled HTML file. The conversation tables and the Markdown file body
are byte-identical (minus the Markdown file's YAML front-matter, which carries
run metadata so re-runs can be diffed). Once both files exist, the chat output
proceeds in this fixed order: **(1)** the report body (title, metadata table,
Design section, severity tables, or the empty-findings line), **(2)** the
`**Report files:**` trailer with markdown links to the two files. Nothing
else may follow the trailer.

All markdown tables in the report (the metadata table at the top and every
severity table) must have every cell (header, separator, body) padded with
spaces (or dashes for the separator row) so all cells in the same column
occupy the same character width between pipes.

**Filename convention:**

```
pr-review-<branch>-<base>-<head7>.md
pr-review-<branch>-<base>-<head7>.html
```

- `<branch>`: the current branch name with `/` replaced by `-`.
- `<base>`: the base branch name (`main`, `develop`, …). Always required;
  the review scope changes if the base changes.
- `<head7>`: the first 7 characters of the HEAD SHA. Pins the report to
  the exact code reviewed.

Re-running the review against the same `<branch, base, head7>` overwrites
the prior report; that is intentional, since the inputs are identical.
Lowercase the filename throughout.

Create the `.tmp/sessions/<session-id>/` directory if it does not yet
exist (`mkdir -p`). Do not write reviews anywhere else (not `.claude/`,
not the repo root, not `vendor/`); this is enforced by AGENTS.md.

**Markdown file shape:**

```markdown
---
branch: develop
base: main
head: <40-character HEAD SHA>
pr: null
generated: <ISO 8601 timestamp with timezone>
files-changed: 6
diff-loc: +390 / -0
findings:
  critical: <count>
  high: <count>
  medium: <count>
---

# PR Review

## develop (vs main)

| Field     | Value                                                                        |
| --------- | ---------------------------------------------------------------------------- |
| Branch    | [`develop`](https://github.com/OWNER/REPO/tree/develop) → [`main`](https://github.com/OWNER/REPO/tree/main) |
| HEAD      | [`head7`](https://github.com/OWNER/REPO/commit/head7)                        |
| PR        | [#42](https://github.com/OWNER/REPO/pull/42) (or `none` when no PR is open)  |
| Generated | YYYY-MM-DD HH:MM                                                              |
| Diff      | 6 files · +390 · −0                                                          |
| Findings  | 🔴 0 Critical · 🟠 1 High · 🟡 6 Medium                                      |

### Design

- ...

### Critical

| File | Description |
| ---- | ----------- |
| ...  | ...         |

### High

...

### Medium

...
```

The metadata block is a 2-column GFM table with explicit `Field` / `Value`
headers; renders cleanly in chat (where HTML would show as raw tags), in
the on-disk Markdown, and in the rendered HTML. Severity glyphs
(🔴 🟠 🟡) replace coloured pills to keep the recipe free of custom CSS
while staying scannable.

Metadata-row formatting rules:

- **Branch:** link both branches to their GitHub tree URLs:
  `https://github.com/<owner>/<repo>/tree/<branch-name>`. Multi-segment
  branch names (e.g. `feature/foo`) work without encoding because the
  `tree/` path accepts literal slashes; percent-encode any branch name
  that contains spaces or other reserved characters.
- **HEAD:** use the 7-char short SHA in both the link label and the
  URL (`/commit/<head7>`). The full SHA still lives in the YAML front
  matter and the filename for unambiguous traceability; the short SHA
  in the URL keeps the row narrow enough that the OpenCode TUI does
  not wrap the Field column. GitHub redirects `/commit/<short>` to the
  full commit, so the link resolves identically.
- **Diff:** plain text, no colour, no emoji. Format:
  `<files> files · +<additions> · −<deletions>`, with middle dots
  (` · `, U+00B7) as separators. Use the Unicode minus sign
  (U+2212, `−`) for the deletions count, not the ASCII hyphen-minus,
  for typographic correctness. Plain text renders identically in the TUI,
  the standalone HTML, and the github.com web view.

`pr` is the PR number when one exists, `null` otherwise. `findings` is an
omittable subkey when its severity is empty (e.g. omit `medium:` when
there are no Medium findings); doing so keeps the front-matter aligned
with the printed tables.

**HTML rendering:**

The HTML file is generated from the Markdown file via GitHub's `/markdown`
API and a vendored stylesheet. The skill ships two template files in its
own directory:

- `templates/report.html`: page wrapper containing `{{TITLE}}`,
  `{{CSS}}`, and `{{CONTENT}}` placeholders. Inlines the CSS so the
  rendered HTML is a single, self-contained file (no sibling CSS to keep
  in sync, no network dependency at view time).
- `templates/github-markdown.css`: vendored from the
  `github-markdown-css` npm package. Version pinned in the file header.

Steps:

1. Read the `.md` file as UTF-8.
2. Strip the leading YAML front matter (regex anchored at start of file:
   `(?ms)\A---\r?\n.*?\r?\n---\r?\n\r?\n?`). The metadata table that
   follows the front matter stays in the body and renders into the HTML
   as a regular GFM table.
3. Send the stripped body to `POST /markdown` with `mode=gfm` and capture
   the rendered HTML fragment.
4. Substitute `{{TITLE}}` (the report's H1 followed by ` — ` followed
   by the H2, so the wrapper `<title>` element keeps the branch
   reference even though the body splits the heading across H1
   `PR Review` and H2 `<branch> (vs <base>)`), `{{CSS}}` (verbatim
   contents of `templates/github-markdown.css`), and `{{CONTENT}}` (the
   captured fragment) into `templates/report.html`. Do not URL-encode
   the substitutions; they are embedded verbatim into HTML and CSS
   contexts respectively.
5. Write the assembled HTML to disk as UTF-8 without BOM.

Canonical Bash invocation (Linux/macOS):

```Bash
sed '1{/^---$/!q;};1,/^---$/d' <report.md> \
    | gh api --method POST /markdown --field mode=gfm --field text=@- \
    > <fragment.html>
```

**Windows / PowerShell:** PowerShell on Windows decodes subprocess stdout
via the console's `OutputEncoding`, which on a German Windows host
defaults to **CP-850** (the OEM code page). Capturing `gh api`'s UTF-8
response via `>` or `|` without overriding this re-decodes the bytes
through CP-850 and produces double-encoded mojibake (e.g. `—` becomes
`ÔÇö`, `ü` becomes `├╝`). Override the encoding before invoking `gh` and
use `[System.IO.File]` for the final write; `Set-Content` defaults to
the local ANSI code page on PowerShell 5.1:

```PowerShell
$body = [System.IO.File]::ReadAllText($mdPath,
    [System.Text.UTF8Encoding]::new($false))
$body = $body -replace '(?ms)\A---\r?\n.*?\r?\n---\r?\n\r?\n?', ''
$tmp  = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($tmp, $body,
    [System.Text.UTF8Encoding]::new($false))

$prev = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
try {
    $fragment = & gh api --method POST /markdown `
        --field mode=gfm --field "text=@$tmp" | Out-String
} finally {
    [Console]::OutputEncoding = $prev
    Remove-Item $tmp -Force
}

$output = $template.Replace('{{TITLE}}', $title).
    Replace('{{CSS}}', $css).Replace('{{CONTENT}}', $fragment)
[System.IO.File]::WriteAllText($htmlPath, $output,
    [System.Text.UTF8Encoding]::new($false))
```

**Failure handling:**

| Failure                                | Behavior                                                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown write fails                   | Print a one-line `Failed to write report file: <reason>` notice, then print the full report body to chat anyway so the work is not lost. Skip the HTML step. Skip the trailer.            |
| `.tmp/sessions/<session-id>/` missing  | Create it with `mkdir -p` before writing.                                                                                                                                                 |
| `gh api /markdown` fails               | Keep the `.md` file. Skip the `.html` step. The trailer afterwards lists only the `.md` artifact. Surface a one-line note in the conversation before printing the report body.            |
| Network unavailable                    | Same as above; Markdown succeeds, HTML is skipped with a note, trailer lists only the `.md` artifact.                                                                                     |
| `gh` not authenticated                 | Same as `gh api` failure; markdown only, with a one-line note, trailer lists only the `.md` artifact.                                                                                     |

After both files are written, the **last** thing printed in the conversation
is the `**Report files:**` trailer, a markdown bullet list of the artifacts
linked via `file://` URIs. The HTML link is listed first so the default
click-target opens the rendered view in the browser (Chrome handles `.html`
natively); the Markdown link is listed second as the source artifact. The
trailer enumerates only the artifacts that were written successfully (so a
Markdown-only run shows a one-item trailer with just the source link).
Example:

```markdown
**Report files:**

- [Rendered view (HTML, opens in browser)](file:///D:/Arbeit/windows_llama.cpp/.tmp/sessions/01J.../pr-review-develop-main-136fd56.html)
- [Markdown source](file:///D:/Arbeit/windows_llama.cpp/.tmp/sessions/01J.../pr-review-develop-main-136fd56.md)
```

The Markdown link opens in the OS-default `.md` handler, typically a text
editor (Notepad, VS Code, Typora) on Windows, not the browser. Users who
want `.md` clicks to open in Chrome can set the Windows file association or
install a local-file Markdown viewer extension; the skill cannot dictate
the handler from a `file://` URL.

The `file://` URI MUST use forward slashes on every platform. On Windows,
that means converting the absolute path's backslashes to forward slashes and
prefixing the drive letter as `file:///D:/...` (three slashes; no host
segment). Paths containing spaces or other reserved characters must be
URL-encoded (`%20` etc.).

### Link Format

This section defines how links appear in the output tables. Follow these
rules exactly.

**Columns:** File, Description. The File column contains a markdown link. The
link label is the file path relative to the repository root with a leading
`/`, plus the line range in `:{start}-{end}` format (e.g.,
`/examples/speed-bench.ps1:41-43`). The link URL is the full GitHub
URL constructed as described below.

**Line range:** Include 1 line of context before and after the finding. A
finding on line 42 links to lines 41-43. A finding spanning lines 42-45
links to lines 41-46. The label always uses `:{start}-{end}` regardless of
whether the URL uses `L` or `R` anchors.

**SHA-256 hash for PR links:** Compute the SHA-256 hex digest of each unique
file path via Node.js (cross-platform):
`node -e "process.stdout.write(require('crypto').createHash('sha256').update('{path}').digest('hex'))"`.

**When a PR exists:** Use PR deep links. The URL format is
`https://github.com/{owner}/{repo}/pull/{pr-number}/files#diff-{sha256}R{start}-R{end}`.

**When no PR exists (fallback):** Use blob links with the full HEAD SHA:
`https://github.com/{owner}/{repo}/blob/{full-sha}/{path}#L{start}-L{end}`.
Note: blob links use `L` (not `R`) for line anchors.

**Correct: markdown links with file path labels.**

```markdown
| File                                                                                                            | Description                  |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| [/examples/speed-bench.ps1:41-43](https://github.com/owner/repo/pull/42/files#diff-a1b2c3d4e5f6a7b8c9d0R41-R43) | Unquoted path breaks on space |
| [/examples/speed-bench.ps1:41-43](https://github.com/owner/repo/blob/4a7c9e1f/examples/speed-bench.ps1#L41-L43) | Unquoted path breaks on space |
```

**Wrong: do NOT use any of these formats.**

```markdown
| https://github.com/owner/repo/pull/42/files#diff-a1b2c3d4e5f6a7b8c9d0R41-R43 | ...  |
| [https://github.com/...](https://github.com/...)                             | ...  |
| [speed-bench.ps1:41-43](https://github.com/...)                              | ...  |
```

The first is wrong because it uses a raw URL instead of a markdown link. The
second is wrong because the label is a URL instead of a file path. The third
is wrong because it uses a filename only; the label must be the full path
from the repository root with a leading `/`.

**Full output template:**

```markdown
# PR Review

## develop (vs main)

| Field     | Value                                                                        |
| --------- | ---------------------------------------------------------------------------- |
| Branch    | [`develop`](https://github.com/owner/repo/tree/develop) → [`main`](https://github.com/owner/repo/tree/main) |
| HEAD      | [`head7`](https://github.com/owner/repo/commit/head7)                        |
| PR        | [#42](https://github.com/owner/repo/pull/42) (or `none` when no PR is open)  |
| Generated | YYYY-MM-DD HH:MM                                                              |
| Diff      | 6 files · +390 · −0                                                          |
| Findings  | 🔴 0 Critical · 🟠 1 High · 🟡 6 Medium                                      |

### Design

- <Qualitative observation about scope, placement, or complexity>

### Critical

| File                                                                                                          | Description                |
| ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| [/rebuild_llama.cpp.ps1:41-43](https://github.com/owner/repo/pull/42/files#diff-a1b2c3d4e5f6a7b8c9d0R41-R43)  | Destroys tree on running proc |

### High

| File                                                                                                       | Description               |
| ---------------------------------------------------------------------------------------------------------- | ------------------------- |
| [/examples/server.ps1:14-19](https://github.com/owner/repo/pull/42/files#diff-f6a7b8c9d0a1b2c3d4e5R14-R19) | Unhandled startup failure |
```

### Constraints

- Do NOT modify source code.
- Do NOT post comments, reviews, or any data to GitHub. This skill is
  advisory with respect to GitHub; it never writes there.
- Local-disk writes are permitted only under `.tmp/sessions/<session-id>/`
  and only for the Markdown and HTML report files described in
  *Output Files*. Do not touch `.claude/`, the repo root, or `vendor/`.
- Do NOT report pure style or formatting preferences.
- Do NOT report issues in generated files, lock files, or changelog entries.
- Do NOT report findings inside `vendor/`.
- File cells in output tables must use markdown link syntax with the file
  path as label; see the Link Format section.
