# Project Configuration

## Yay Memory Bank

This section is auto-managed by `/yay:init`. Do not edit manually.

- **Yay Version**: 2.2.4
- **Initialized**: 2026-09-29
- **Last Updated**: 2026-09-29

## Git & Branching (v2)

Read by every yay command for branch routing and protected-branch enforcement (see `context/branch-routing.md`).

```yaml
metadata_branch: main
protected_branches: [main]
pr_target: main
admin_branch: chore/yay-admin
sync_automation: none
archive_strategy: push-and-pr
worktree_root: ~/yay-wt/shared-game-management/
```

## Agent Backends

Per-project source of truth for which backend drives each workflow seam. Values are `<provider>[:<model>]`.

```yaml
backends:
  plan:                  anthropic
  tdd:                   anthropic
  code-review:           codex
  creative-architecture: anthropic
  creative-uiux:         anthropic
  creative-algorithm:    anthropic
  creative-user-journey: anthropic
  creative-critique:     codex
  auto-final-review:     codex
  availability:          auto
```

## Team

```yaml
team:
  # <git-email>: <friendly first name> — self-populating; see
  # context/branch-routing.md § Team Roster. Do not collect the full team here.
  quy.n@argustracking.com: Quy
```
