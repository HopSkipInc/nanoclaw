# NanoClaw — Team State

Last updated: 2026-03-13

## Architecture & Key Decisions
<!-- Decisions the whole team should know. Include the "why" not just the "what". -->

## Conventions
<!-- Patterns, naming, tooling choices that apply across the team. -->

## Current Sprint Focus
<!-- Team-level "what are we working on right now" -->

## Elicitation Prompts

<!-- These prompts guide the AI to capture richer context at decision moments.
     The answers aren't for you — they're for your teammates who read the digest. -->

When a technical or product decision is made without stated reasoning, ask one of:
- "What alternatives did you consider?"
- "What constraint or requirement drove this choice?"
- "What would need to change for you to reverse this decision?"
- "Who else on the team does this affect, and how?"
- "What's the risk if this assumption is wrong?"

Do not ask if the decision already includes reasoning, tradeoffs, or constraints.
Do not ask more than once per decision. Do not ask during routine implementation.

## Shared Gotchas
<!-- Hard-won lessons. What surprised us. What NOT to do. -->


### Context shift detected (2026-03-13)
Major strategic pivot: Meridian project launched with open-core licensing model, Apache 2.0 for local tooling, deferred multi-agent support, and blocking launch decision on open/closed boundaries.

## Meridian Open-Core Launch (2026-03-13)

**Strategy locked**: Apache 2.0 for CLI, setup, hooks, templates (open). Cloud control plane, license enforcement, digest infrastructure, billing stay proprietary. Multi-agent specialization deferred post-launch; Claude Code is launch target. Hook schema now requires {matcher, hooks} wrapper; setup.sh normalizes malformed structures. Launch blocker #83: open/closed boundaries must stay committed. README split: open features (CLI, journals, specializations) vs. commercial (digests, Slack, deployment).
