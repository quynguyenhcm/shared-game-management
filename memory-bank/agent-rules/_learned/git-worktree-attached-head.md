---
name: Keep worktree HEAD attached to the feature branch
globs: []
paths: ["yay-wt/"]
topics: ["git", "worktree", "build", "commit", "detached head"]
priority: low
auto_generated: true
derived_from: [platform-foundation]
evidence_count: 1
last_validated: 2026-09-30
---

# Assert an attached HEAD in build worktrees

- At the start and end of every build phase, run `git symbolic-ref HEAD` in the worktree and check that it is `refs/heads/feature/<slug>`, and that the branch ref equals `HEAD`. In platform-foundation, Phases 4–6 were committed on a detached HEAD, and the branch ref lagged 5 commits behind until it was fast-forwarded.
- Never commit from a detached HEAD. If one is found, fast-forward the branch to it (`git branch -f feature/<slug> HEAD && git switch feature/<slug>`) and verify the history is linear.
