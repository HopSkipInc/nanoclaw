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

## Elicitation Prompts

<!-- These prompts guide the AI to capture richer context at decision moments.
     The AI should ask AT MOST ONE of these when a significant decision is stated
     without reasoning. Do not ask during routine implementation — only at moments
     where a choice was made between alternatives.

     The answers aren't for you (you already know) — they're for your teammates
     who will read the digest tomorrow. -->

When a technical or product decision is made without stated reasoning, ask one of:
- "What alternatives did you consider?"
- "What constraint or requirement drove this choice?"
- "What would need to change for you to reverse this decision?"
- "Who else on the team does this affect, and how?"
- "What's the risk if this assumption is wrong?"

Do not ask if the decision already includes reasoning, tradeoffs, or constraints.
Do not ask more than once per decision. Do not ask during routine implementation.

## Shared Gotchas

- Container image must be rebuilt after ai-fleet repo changes (`./container/build.sh`)
- 19 repos registered in `~/.config/nanoclaw/repo-registry.json`
- ai-fleet default branch is `master` not `main`
- `FLEET_SIMULATE=1` in .env activates the test simulator — remove for real fleets
- `LOG_LEVEL=debug` in .env creates verbose logs — remove after debugging
- Clearing bot session requires SSH + sqlite3 + service restart (no `/reset` command yet)
- Session persistence can cause stale behavior after CLAUDE.md changes — clear session if agent ignores new instructions


### Context shift detected (2026-03-17)
Strategic pivot from NanoClaw dev automation to SDR bot platform. Team decisions locked SDR architecture (4-phase rollout, housed in research repo, NanoClaw as orchestrator, dedicated agent instance, email channel integration). Multiple infrastructure decisions deferred pending team input on email identity and approval gates.

## SDR Bot Initiative (2026-03-17)

Strategic decision: Build SDR automation on NanoClaw infrastructure rather than third-party tools. Architecture locked:
- 4-phase rollout (brief-to-list → draft → reply triage → cadence), phases 1-2 require AE approval
- Logic housed in HopSkipInc/research repo under campaign-briefs/ workspace
- Dedicated SDR agent instance within NanoClaw container model (separate from dev agent)
- Phase 3: email channel (M365/Gmail) for reply classification and follow-up drafting
- Pending: email identity (SDR account vs. per-AE), autonomy approval gates, persona scope (hotel-only or multi-sided)
- Outbound sequencing tool decision deferred (HubSpot sequences vs. Instantly/Smartlead)
