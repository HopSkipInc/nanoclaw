#!/bin/bash
set -e

# Fleet entrypoint for NanoClaw container.
# Reads fleet task config from stdin JSON, injects team context,
# runs ai-fleet bootstrap.sh, and writes result as output markers.

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

# Read input JSON from stdin (read until first complete JSON object, then proceed)
# We can't rely on EOF because the host keeps stdin open for fleet tasks.
head -1 > /tmp/input.json

# Parse fleet config from input JSON
GOAL=$(jq -r '.fleetTask.description // empty' /tmp/input.json)
AGENTS=$(jq -r '.fleetTask.agents // empty' /tmp/input.json)
TIMEOUT_MINUTES=$(jq -r '.fleetTask.timeoutMinutes // empty' /tmp/input.json)
TEAM_CONTEXT=$(jq -r '.fleetTask.teamContext // empty' /tmp/input.json)
REPO_PATH="/workspace/code"
STATUS_DIR="/workspace/fleet-status"

# Verify bootstrap.sh exists
if [ ! -f /opt/ai-fleet/bootstrap.sh ]; then
  emit_output "error" "" "ai-fleet toolkit not found in container. Rebuild with ai-fleet repo available."
  exit 1
fi

# Verify repo is mounted (worktrees have a .git file, not a directory)
if [ ! -e "$REPO_PATH/.git" ]; then
  emit_output "error" "" "No git repository found at $REPO_PATH"
  exit 1
fi

mkdir -p "$STATUS_DIR"

# --- Inject team context into the worktree ---
# Fleet agents run in the worktree with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1.
# Writing team context to .claude/team-context.md in the worktree makes it visible
# to all Claude Code agents automatically via the additional directories feature.
if [ -n "$TEAM_CONTEXT" ]; then
  mkdir -p "$REPO_PATH/.claude"
  printf '%s\n' "$TEAM_CONTEXT" > "$REPO_PATH/.claude/team-context.md"
fi

# Build bootstrap.sh arguments
ARGS=(--repo "$REPO_PATH" --headless --wait --status-dir "$STATUS_DIR")
[ -n "$GOAL" ] && ARGS+=(--goal "$GOAL")
[ -n "$AGENTS" ] && ARGS+=(--agents "$AGENTS")
[ -n "$TIMEOUT_MINUTES" ] && ARGS+=(--timeout "$TIMEOUT_MINUTES")

# Emit start notification
emit_output "success" "Fleet starting with $(echo "${AGENTS:-super,critic,eng1,eng2,qa1}" | tr ',' '\n' | wc -l | tr -d ' ') agents..."

# Graceful shutdown: forward SIGTERM to bootstrap.sh so it can wrap up
BOOTSTRAP_PID=""
cleanup() {
  if [ -n "$BOOTSTRAP_PID" ] && kill -0 "$BOOTSTRAP_PID" 2>/dev/null; then
    kill -TERM "$BOOTSTRAP_PID" 2>/dev/null || true
    # Wait up to 60s for graceful shutdown
    local waited=0
    while kill -0 "$BOOTSTRAP_PID" 2>/dev/null && [ "$waited" -lt 60 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$BOOTSTRAP_PID" 2>/dev/null; then
      kill -9 "$BOOTSTRAP_PID" 2>/dev/null || true
    fi
  fi
}
trap cleanup SIGTERM SIGINT

# Run fleet bootstrap in background so we can trap signals
EXIT_CODE=0
/opt/ai-fleet/bootstrap.sh "${ARGS[@]}" 2>&1 &
BOOTSTRAP_PID=$!
wait "$BOOTSTRAP_PID" || EXIT_CODE=$?

# Read fleet status
FLEET_STATUS="unknown"
FLEET_MESSAGE=""
if [ -f "$STATUS_DIR/fleet-status.json" ]; then
  FLEET_STATUS=$(jq -r '.status // "unknown"' "$STATUS_DIR/fleet-status.json")
  FLEET_MESSAGE=$(jq -r '.message // ""' "$STATUS_DIR/fleet-status.json")
fi

# Emit final result
if [ "$EXIT_CODE" -eq 0 ] || [ "$FLEET_STATUS" = "success" ] || [ "$FLEET_STATUS" = "completed" ]; then
  SUMMARY="Fleet completed (${FLEET_STATUS})"
  [ -n "$FLEET_MESSAGE" ] && SUMMARY+=": $FLEET_MESSAGE"
  emit_output "success" "$SUMMARY"
else
  ERROR_MSG="Fleet exited with status ${FLEET_STATUS} (exit code ${EXIT_CODE})"
  [ -n "$FLEET_MESSAGE" ] && ERROR_MSG+=": $FLEET_MESSAGE"
  emit_output "error" "" "$ERROR_MSG"
fi
