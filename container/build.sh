#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# --- ai-fleet toolkit ---
# Copy minimal toolkit files into build context (Docker COPY requires them here).
# Cleaned up after build so they don't linger in the repo.
AI_FLEET_DIR="${AI_FLEET_DIR:-$HOME/repos/HopSkipInc/ai-fleet}"
AI_FLEET_BUILD_DIR="$SCRIPT_DIR/ai-fleet"

cleanup_ai_fleet() {
  rm -rf "$AI_FLEET_BUILD_DIR"
}
trap cleanup_ai_fleet EXIT

if [ -d "$AI_FLEET_DIR" ]; then
  echo "Copying ai-fleet toolkit from $AI_FLEET_DIR..."
  mkdir -p "$AI_FLEET_BUILD_DIR/lib" "$AI_FLEET_BUILD_DIR/claude-md-templates/base"
  cp "$AI_FLEET_DIR/bootstrap.sh" "$AI_FLEET_BUILD_DIR/"
  cp "$AI_FLEET_DIR/install-tools.sh" "$AI_FLEET_BUILD_DIR/"
  cp "$AI_FLEET_DIR"/lib/*.sh "$AI_FLEET_BUILD_DIR/lib/"
  cp "$AI_FLEET_DIR"/claude-md-templates/base/*.md "$AI_FLEET_BUILD_DIR/claude-md-templates/base/"
else
  echo "NOTE: ai-fleet toolkit not found at $AI_FLEET_DIR"
  echo "      Fleet tasks will not be available in this build."
  echo "      Clone HopSkipInc/ai-fleet and rebuild to enable fleet support."
  echo ""
  # Create empty placeholder so COPY ai-fleet/ doesn't fail
  mkdir -p "$AI_FLEET_BUILD_DIR"
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
