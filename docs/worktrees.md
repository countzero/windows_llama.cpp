# Git Worktree Reference

Read before creating, using or removing a git worktree.

The short rule is `AGENTS.md` -> *Shared working tree*; this file carries the procedure and the
submodule-specific cleanup that a plain `git worktree remove` refuses.

## When to create one

Worktrees are optional. Create one only when the user asks for one, or when the preflight
(`git status --porcelain -u`, `docs/conventions.md` -> *Shared working tree*) shows foreign work
in progress on files you must modify. Sharing the main working tree is the default; a worktree is
the escape hatch when two agents would otherwise collide in the same file.

**A worktree is for prose, presets and scripts, not for builds.** Its `vendor/llama.cpp` and
`vendor/Qwen-Fixed-Chat-Templates` are empty directories (measured: `git submodule status` lists
both with a leading `-`), so a build there needs its own submodule clone and a full CUDA build, and
every preset that names `vendor\...` (a `chat-template-file`, for instance) points at nothing.
Build, benchmark and run the router from the main working tree.

## Location and naming

Create the worktree at `.worktrees/<branch-slug>/`, the branch name lowercased with `/` replaced by
`-` (`.worktrees/feature-bonsai-2/`). `.worktrees/` is gitignored. The layout is flat, one
directory below the repository root, because absolute paths must stay under the Windows
260-character `MAX_PATH` limit, and relative paths have no long-path opt-out.

## Creating the worktree

On a fresh branch:

```powershell
git worktree add -b feature/bonsai-2 .worktrees/feature-bonsai-2 develop
```

Git refuses to check out a branch that is already checked out in another worktree, so an existing
branch is taken detached instead:

```powershell
git worktree add --detach .worktrees/feature-bonsai-2 feature/bonsai-2
```

`-b` is written short because `git worktree add` has no long form for it.

The start point must be current. When the main checkout sits on another branch, local `develop` is
easily stale, and branching from `origin/develop` instead makes the new branch **track
`origin/develop`**: a bare `git push` is then refused, and the refusal's first suggestion,
`git push origin HEAD:develop`, writes the feature branch to `develop`. Either update local
`develop` first, or make the first push explicit:

```powershell
git push --set-upstream origin feature/bonsai-2
```

Verify with `git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'` before the first
push; it must not print `origin/develop`.

## Entering it with the running session

A worktree reached only through a per-call working directory is half a worktree: the first tool
call that forgets the argument writes to the main tree. Create the worktree with git as above, then
move the session with OpenCode's built-in `session_move` tool (Code Mode namespace `opencode`,
reached through `execute`): target `.worktrees/<branch-slug>` to enter, the main working tree to
leave. A relative target resolves against the session's current directory, so from inside a
worktree the main tree is `../..`. The move takes effect at the next safe boundary, and it moves
only the calling session; a subagent re-homes its own child session. OpenCode's `worktree_create`
is no substitute for the git command: it checks out a detached HEAD with no branch.

`.opencode/plugins/worktree-guard.js` refuses every other target before the move runs: anything
that is neither the main tree nor an existing directory named as a lowercase branch slug directly
below `.worktrees/`, a move to where the session already is, and a move of another session. The
point is that a mistyped or invented path must not re-home a session into an unrelated directory,
`vendor/` included.

A move lands the session in a different tree: read the branch and run the preflight again
(`docs/conventions.md` -> *Shared working tree*) before writing or committing.

**Never use the `/move` dialog.** When the source tree has changes it preselects carrying them
along, which applies them at the destination and discards them at the source, untracked files
included. In the shared main working tree that destroys every other agent's work.

## Scratch artefacts

Scratch files stay in the **main** repository's `.tmp/sessions/<session-id>/`, never inside the
worktree, because `git worktree remove` deletes an ignored `.tmp/` along with everything else.
From inside a worktree, `git rev-parse --path-format=absolute --git-common-dir` names the main
repository's `.git`, whose parent is the main tree.

That location is outside the working directory of a session in a worktree, a boundary OpenCode
guards. `.opencode/opencode.json` carries the one exception. OpenCode matches a path inside the
session's directory as a repo-relative path and one outside it as an absolute path such as
`D:/...`, so the deny rules on `?:/*` and `/*` refuse every edit outside the worktree, and the allow
on `*/.tmp/*` re-admits the main tree's `.tmp/`. OpenCode takes the **last** matching rule, which is
why the allow stands after the denies.

## Cleanup

`git worktree remove` refuses a worktree whose submodules were ever initialized, with
`fatal: working trees containing submodules cannot be moved or removed`, and `submodule deinit`
alone does not lift the refusal: the clones stay under the worktree's own git directory. Measured
order that removes it cleanly:

```powershell
$worktree = '.worktrees/feature-bonsai-2'
git -C $worktree status --short                       # must be empty, or commit first
$gitDir = git -C $worktree rev-parse --absolute-git-dir
git -C $worktree submodule deinit --all
Remove-Item -LiteralPath "$gitDir/modules" -Recurse -Force
git worktree remove $worktree
```

`$gitDir` is `.git/worktrees/<name>`, never the main `.git`; check it before the `Remove-Item`. A
worktree that never initialized a submodule is removed by the last line alone.

Never reach for `--force`, never for `--force --force` on a locked tree, and never for
`git worktree prune`. If `git worktree remove` still refuses, surface the refusal to the user
instead of escalating.
