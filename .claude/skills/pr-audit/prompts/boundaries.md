You read the working tree at HEAD and the git history (`git show`,
`git diff`, `git log`, `git rev-parse`, `git merge-base`) and write the output
file and no other. The harness's own read, search and file-listing tools
(Read, Grep, Glob or their equivalents) are reading the tree and allowed. You
run no shell command but these git commands and the check this prompt names:
no build, no test, no install, and nothing on GitHub. When a tool
call is refused or a file is missing, say so in your final message instead of
working around it.
