# NanoClaw — Team State

Last updated: 2026-03-16

## Architecture & Key Decisions

### ai-fleet Integration (Track B — Complete)

Full fleet pipeline: Slack trigger → estimate → fleet → PR. Three commands:
- `code <repo> <desc>` — single-agent one-shot coding task
- `estimate <repo> <desc>` — interactive estimator session with read-only repo access
- `fleet <repo> <desc>` — multi-agent fleet via bootstrap.sh in container

Key decisions:
- Fleet containers keep stdin open (prevents premature exit), use `head -1` to read input JSON
- Git worktree .git checks use `-e` not `-d` (worktrees have .git files, not directories)
- QA clone failures in bootstrap.sh are non-fatal — QA shares main worktree in containers
- Estimate sessions are interactive conversations (not one-shot) with read-only repoMount
- Decisions flow through Wayfind journal — no separate fleet brief artifact
- Fleet entrypoint injects team context as `.claude/team-context.md` in worktree
- `loadTeamContext()` reads today's journal entries so estimate decisions feed into fleet context
- Progress relay polls fleet-status.json + progress.jsonl every 10s, posts to Slack thread
- Estimator can launch fleets directly via IPC (`launch_fleet` type)

### C7: Natural Language Task Routing (Complete)

`src/intent-classifier.ts` — Haiku-based classifier replaces rigid `command <repo> <description>` syntax.

Key decisions:
- Classifier runs AFTER regex parsers (backwards-compatible — explicit commands still work)
- Regex parsers now validate repo name against registry — unknown repo → falls through to classifier
- Three confidence tiers: high (≥0.85) → direct route, medium (0.5–0.84) → confirmation prompt, low (<0.5) → chat
- Raw HTTPS to Anthropic API (no SDK dependency on host side)
- Repo registry descriptions passed as context to classifier (name + description from repo-registry.json)
- Pending confirmations: in-memory map keyed by chatJid, 5min timeout, approval regex
- Confirmation handled in both pollAndProcess path and startMessageLoop path

### Container IPC Snapshots

Three snapshot files written to `/workspace/ipc/` before each container launch:
- `current_tasks.json` — scheduled tasks (main sees all, others see own)
- `available_groups.json` — registered groups (main only)
- `available_repos.json` — repo registry (main only) — NEW in 2026-03-16

## Current Sprint Focus

Track C — Advanced ai-fleet integration.

Active issues:
- C1 (#13): Mid-fleet Slack → super relay — fleet-side MERGED, NanoClaw host side TBD
- C2 (#14): Fleet cost history feedback loop
- ~~C7 (#19): Natural language task routing~~ — DONE
- C8 (#21): Fleet without local repo clones (prerequisite for Azure/shared hosts)

Next: C8 (Azure), then Wayfind as semantic layer for smarter repo resolution.

## Shared Gotchas

- Container image must be rebuilt after ai-fleet repo changes (`./container/build.sh`)
- 19 repos registered in `~/.config/nanoclaw/repo-registry.json`
- ai-fleet default branch is `master` not `main`
- `FLEET_SIMULATE=1` in .env activates the test simulator — remove for real fleets
- `LOG_LEVEL=debug` in .env creates verbose logs — remove after debugging
- Clearing bot session requires SSH + sqlite3 + service restart (no `/reset` command yet)
- Session persistence can cause stale behavior after CLAUDE.md changes — clear session if agent ignores new instructions
