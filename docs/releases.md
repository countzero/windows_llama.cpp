# Releases

Release order, version, tag on the merge commit, release body, back-merge into `develop`. Read
before a release pull request or publishing a release.

## Order of operations

| Step | What                                                                  | Where                                                 |
| ---- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| 1    | Confirm the newest changelog section on the pushed `develop`          | *Version*                                             |
| 2    | Open the pull request `Release vX.Y.Z` from `develop` into `main`     | `docs/conventions.md` -> *Pull request descriptions*  |
| 3    | Merge it with a merge commit: `gh pr merge <number> --merge`          |                                                       |
| 4    | Publish from the merge commit                                         | *Publishing*                                          |
| 5    | Bring `main` back into `develop` and push it                          | *Back into develop*                                   |
| 6    | Verify                                                                | *Verify*                                              |

There is no release commit. Every change already carries its own `CHANGELOG.md` section on
`develop` (`docs/conventions.md` -> *Changelog*), so the release only names the newest one.

## Version

The release is the newest `## [X.Y.Z]` heading on `develop`. The sections between the previous
tag and it ship as they are: they are not merged into one, and the versions in between are never
tagged. A release whose newest section is older than a commit on `develop` is not cut until that
commit has its own section.

## Publishing

The tag names the merge commit of the release pull request, the state `main` took. Pass its SHA
to `--target`, not `main`, which can move before the publish. The release is named `vX.Y.Z`, and
its body is two links:

```markdown
- [Changelog](https://github.com/countzero/windows_llama.cpp/blob/main/CHANGELOG.md#<anchor>)
- [Code Changes](https://github.com/countzero/windows_llama.cpp/compare/v<previous>...vX.Y.Z)
```

The pull request and the changelog already say what shipped; a third copy is the one nobody
reviews. The anchor is GitHub's slug of the heading: `## [1.58.0] - 2026-10-21` becomes
`#1580---2026-10-21`.

```powershell
git fetch origin
git log --max-count=1 --format='%H %s' origin/main   # the release pull request's merge commit
gh release create vX.Y.Z --target <merge-sha> --title vX.Y.Z --notes-file <file>
```

The notes file goes under `.tmp/sessions/<session-id>/`. Publish neither a draft, which creates
no tag, nor a prerelease, which `/releases/latest` skips. Type the body fresh; a copied one is how
one of the compare link's two versions stays stale.

## Back into develop

The merge commit exists only on `main`. In the main working tree, on `develop`:
`git merge --ff-only origin/main`, or `git merge origin/main` when `develop` has moved on, then
`git push origin develop`. Without it the tag is unreachable from `develop`, and
`v<previous>..develop` lists commits already released. The always-dirty `vendor/llama.cpp`
(`docs/build_system.md` -> *Submodule lifecycle*) does not block the merge.

## Verify

| Check                                     | Command                                                           |
| ----------------------------------------- | ----------------------------------------------------------------- |
| The tag is on the merge commit            | `git fetch --tags; git log --max-count=1 --format='%h %s' vX.Y.Z` |
| Neither a draft nor a prerelease          | `gh release view vX.Y.Z --json isDraft,isPrerelease`              |
| It is what `/releases/latest` serves      | `gh release view --json tagName`                                  |
| The changelog anchor lands on the heading | Open the release's Changelog link                                 |
| `develop` contains every commit of `main` | `git rev-list --count origin/develop..origin/main` answers `0`    |
