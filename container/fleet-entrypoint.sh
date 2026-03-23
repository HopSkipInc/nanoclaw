#!/bin/bash
set -e

# Fleet entrypoint for NanoClaw container.
# Reads fleet task config and runs ai-fleet bootstrap.sh.
#
# Config source (auto-detected):
#   stdin JSON   — local Docker mode (host pipes JSON via stdin)
#   env var      — ACI mode (FLEET_CONFIG_JSON env var, no stdin available)
#
# Repo access (auto-detected):
#   mount mode   — repo worktree is bind-mounted at /workspace/code
#   clone mode   — repo is cloned using GITHUB_TOKEN or ADO_PAT from env

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

# --- Read fleet config ---
# ACI mode: config passed as env var (no stdin available in ACI containers)
# Local mode: config piped via stdin from the NanoClaw host
if [ -n "${FLEET_CONFIG_JSON:-}" ]; then
  echo "$FLEET_CONFIG_JSON" > /tmp/input.json
else
  # Read from stdin (first line only — host keeps stdin open for fleet tasks)
  head -1 > /tmp/input.json
fi

# Parse fleet config from input JSON
GOAL=$(jq -r '.fleetTask.description // empty' /tmp/input.json)
AGENTS=$(jq -r '.fleetTask.agents // empty' /tmp/input.json)
TIMEOUT_MINUTES=$(jq -r '.fleetTask.timeoutMinutes // empty' /tmp/input.json)
TEAM_CONTEXT=$(jq -r '.fleetTask.teamContext // empty' /tmp/input.json)
REPO_SLUG=$(jq -r '.fleetTask.repoSlug // empty' /tmp/input.json)
REPO_BRANCH=$(jq -r '.fleetTask.branch // empty' /tmp/input.json)
ISSUE_NUMBER=$(jq -r '.fleetTask.issueNumber // empty' /tmp/input.json)
REPO_PATH="/workspace/code"

# Fleet status directory: in ACI mode, use a per-fleet subdirectory on the
# shared Azure Files mount so concurrent fleets don't stomp on each other.
# FLEET_ID is set by the ACI dispatch module. In local Docker mode it's unset
# and status goes directly to the mount root (single fleet per container).
if [ -n "${FLEET_ID:-}" ]; then
  STATUS_DIR="/workspace/fleet-status/${FLEET_ID}"
else
  STATUS_DIR="/workspace/fleet-status"
fi

# Verify bootstrap.sh exists
if [ ! -f /opt/ai-fleet/bootstrap.sh ]; then
  emit_output "error" "" "ai-fleet toolkit not found in container. Rebuild with ai-fleet repo available."
  exit 1
fi

mkdir -p "$STATUS_DIR"

# --- Repo access: mount mode vs clone mode ---
if [ -e "$REPO_PATH/.git" ]; then
  # Mount mode (local Docker): worktree is already bind-mounted
  echo "Mount mode: repo available at $REPO_PATH"
else
  # Clone mode (ACI): clone the repo using credentials from environment
  echo "Clone mode: cloning $REPO_SLUG"

  if [ -z "$REPO_SLUG" ]; then
    emit_output "error" "" "Clone mode requires fleetTask.repoSlug (e.g. 'HopSkipInc/SomeRepo' or 'ado:Doorbell/SomeService')"
    exit 1
  fi

  # Determine repo type and clone URL
  if [[ "$REPO_SLUG" == ado:* ]]; then
    # ADO repo: ado:project/repo → clone from Azure DevOps
    ADO_SLUG="${REPO_SLUG#ado:}"
    ADO_PROJECT="${ADO_SLUG%%/*}"
    ADO_REPO="${ADO_SLUG#*/}"
    ADO_ORG="${ADO_ORG:-saratogasandboxes}"

    if [ -z "${ADO_PAT:-}" ]; then
      emit_output "error" "" "ADO_PAT environment variable required for ADO repo clone"
      exit 1
    fi

    CLONE_URL="https://${ADO_PAT}@dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_git/${ADO_REPO}"
    git clone --depth=50 "$CLONE_URL" "$REPO_PATH"
  else
    # GitHub repo: org/repo
    if [ -z "${GITHUB_TOKEN:-}" ]; then
      emit_output "error" "" "GITHUB_TOKEN environment variable required for GitHub repo clone"
      exit 1
    fi

    CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_SLUG}.git"
    git clone --depth=50 "$CLONE_URL" "$REPO_PATH"

    # Configure gh CLI for PR creation by fleet agents
    echo "$GITHUB_TOKEN" | gh auth login --with-token 2>/dev/null || true
  fi

  # Check out specific branch if requested
  if [ -n "$REPO_BRANCH" ]; then
    git -C "$REPO_PATH" checkout "$REPO_BRANCH" 2>/dev/null \
      || git -C "$REPO_PATH" checkout -b "$REPO_BRANCH"
  else
    # Create a fleet working branch
    FLEET_BRANCH="fleet/$(date +%Y%m%d-%H%M%S)"
    git -C "$REPO_PATH" checkout -b "$FLEET_BRANCH"
  fi

  # Configure git identity for commits
  git -C "$REPO_PATH" config user.name "ai-fleet"
  git -C "$REPO_PATH" config user.email "ai-fleet@hopskip.com"
fi

# --- Inject team context into the repo ---
# Fleet agents run in the repo with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1.
# Writing team context to .claude/team-context.md makes it visible
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
[ -n "$ISSUE_NUMBER" ] && ARGS+=(--issue "$ISSUE_NUMBER")
# Note: --repo-slug is not a bootstrap.sh flag. The repo slug is used by
# the entrypoint for cloning; bootstrap.sh only needs --repo (the local path).

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
