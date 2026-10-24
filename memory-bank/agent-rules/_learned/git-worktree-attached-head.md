---
name: Keep worktree HEAD attached to the feature branch
globs: []
paths: ["yay-wt/"]
topics: ["git", "worktree", "build", "commit", "detached head"]
priority: low
auto_generated: true
derived_from: [platform-foundation, session-scheduling-engine]
evidence_count: 2
last_validated: 2026-10-24
---

# Assert an attached HEAD in build worktrees

- At the start and end of every build phase, run `git symbolic-ref HEAD` in the worktree and check that it is `refs/heads/feature/<slug>`, and that the branch ref equals `HEAD`. In platform-foundation, Phases 4–6 were committed on a detached HEAD, and the branch ref lagged 5 commits behind until it was fast-forwarded.
- Never commit from a detached HEAD. If one is found, fast-forward the branch to it (`git branch -f feature/<slug> HEAD && git switch feature/<slug>`) and verify the history is linear.
- Do not trust a sub-agent's "pushed" claim. After every phase commit, the orchestrator itself checks that `git symbolic-ref -q HEAD` succeeds and that `git merge-base --is-ancestor HEAD origin/feature/<slug>` passes before it reports the phase pushed. In session-scheduling-engine, Phase 4's two commits sat on a detached HEAD and were reported as pushed. The branch and origin stayed at Phase 3 until Phase 5 noticed.
