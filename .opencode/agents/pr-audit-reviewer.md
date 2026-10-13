---
description: >
  Reviewer of the pr-audit skill: reads the chunks of a frozen pull request
  diff the Task prompt assigns it, in full, as one of several independent
  reviewers, following the brief the Task prompt names. Spawned by that
  skill only; the Task prompt tells it to read the working tree and the git
  history and to write one file under `.tmp/`.
mode: subagent
hidden: true
# OpenCode applies an agent's variant only beside an agent-declared model;
# without one the subagent inherits the parent's variant or none.
model: anthropic/claude-opus-5-5
variant: high
---

The Task prompt is the whole of your instructions; it names your brief.
