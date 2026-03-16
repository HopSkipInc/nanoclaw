#!/bin/bash
set -e

# Fleet simulator for testing the progress relay.
# Drop-in replacement for fleet-entrypoint.sh — writes realistic fleet
# status and progress files over ~30 seconds, then exits success.
#
# Usage: same as fleet-entrypoint.sh (reads JSON from stdin)

OUTPUT_START_MARKER="---NANOCLAW_OUTPUT_START---"
OUTPUT_END_MARKER="---NANOCLAW_OUTPUT_END---"

emit_output() {
  local status="$1" result="$2" error="${3:-}"
  local json
  if [ -n "$error" ]; then
    json="{\"status\":\"${status}\",\"result\":null,\"error\":$(jq -Rn --arg e "$error" '$e')}"
  elif [ -n "$result" ]; then
    json="{\"status\":\"${status}\",\"result\":$(jq -Rn --arg r "$result" '$r')}"
  else
    json="{\"status\":\"${status}\",\"result\":null}"
  fi
  echo "$OUTPUT_START_MARKER"
  echo "$json"
  echo "$OUTPUT_END_MARKER"
}

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

progress() {
  local agent="$1" phase="$2" message="$3"
  printf '{"timestamp": "%s", "agent": "%s", "phase": "%s", "message": "%s"}\n' \
    "$(now_utc)" "$agent" "$phase" "$message" \
    >> "$STATUS_DIR/progress.jsonl"
}

write_status() {
  local status="$1" summary="$2" active="${3:-0}" stale="${4:-0}"
  local now
  now="$(now_utc)"
  printf '{
  "status": "%s",
  "started_at": "%s",
  "updated_at": "%s",
  "duration_seconds": %d,
  "summary": "%s",
  "pr_url": null,
  "error": null,
  "agents": { "total": 5, "active": %d, "stale": %d, "exited": 0 },
  "exit_code": null,
  "goal": "%s",
  "repo": null,
  "issue": null
}\n' "$status" "$STARTED_AT" "$now" "$(($(date +%s) - START_EPOCH))" \
    "$summary" "$active" "$stale" "$GOAL" \
    > "$STATUS_DIR/fleet-status.json"
}

# --- Read input ---
cat > /tmp/input.json
GOAL=$(jq -r '.fleetTask.description // "simulated fleet task"' /tmp/input.json)
STATUS_DIR="/workspace/fleet-status"
mkdir -p "$STATUS_DIR/heartbeats"

STARTED_AT="$(now_utc)"
START_EPOCH="$(date +%s)"

# Initialize
: > "$STATUS_DIR/progress.jsonl"

emit_output "success" "Fleet simulator starting with 5 agents..."

# --- Phase 1: Fleet starting (t=0) ---
write_status "running" "Fleet starting" 5 0
progress "bootstrap" "setup" "Created tmux session with 5 agent panes"
sleep 3

# --- Phase 2: Agents reading context (t=3s) ---
progress "super" "reading" "Reading CLAUDE.md and team-state.md"
progress "eng1" "reading" "Reading project structure and key files"
progress "eng2" "reading" "Analyzing codebase architecture"
sleep 5

# --- Phase 3: Super assigns work (t=8s) ---
progress "super" "planning" "Decomposed task into 3 subtasks, assigning to engineers"
progress "critic" "reviewing" "Reviewing task decomposition for completeness"
write_status "running" "Planning complete, agents coding" 5 0
sleep 5

# --- Phase 4: Engineers coding (t=13s) ---
progress "eng1" "implementing" "Added new API endpoint for fleet status"
progress "eng2" "implementing" "Updated database schema for fleet tracking"
progress "qa1" "testing" "Setting up test fixtures for fleet integration"
sleep 5

# --- Phase 5: More progress (t=18s) ---
progress "eng1" "implementing" "Committed: feat: add fleet status endpoint"
progress "eng2" "implementing" "Committed: feat: add fleet tracking schema"
progress "super" "coordinating" "2/3 subtasks complete, eng1 starting subtask 3"
write_status "running" "2/3 subtasks complete" 5 0
sleep 5

# --- Phase 6: Final work (t=23s) ---
progress "eng1" "implementing" "Committed: feat: wire up fleet progress relay"
progress "qa1" "testing" "All tests passing (12 new, 0 failures)"
progress "critic" "reviewing" "Code review: no issues found, LGTM"
sleep 4

# --- Phase 7: Completion (t=27s) ---
progress "super" "summary" "All 3 subtasks complete. 3 commits, tests passing, code reviewed."
write_status "success" "All subtasks completed successfully" 0 0

emit_output "success" "Fleet completed (success): All subtasks completed. 3 commits across 2 engineers, tests passing, code reviewed."
