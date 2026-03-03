#!/usr/bin/env bash
# Reload the OpenClaw gateway with a fresh TypeScript compilation cache.
#
# Usage:
#   scripts/gateway-reload.sh          # default 30s wait
#   scripts/gateway-reload.sh 20       # custom wait in seconds
#
# Steps:
#   1. Clear the jiti TypeScript compilation cache inside the container
#   2. Restart the gateway container
#   3. Wait for the gateway to be ready

set -euo pipefail

CONTAINER="openclaw-openclaw-gateway-1"
WAIT_SECS="${1:-30}"

echo "==> Clearing jiti cache in ${CONTAINER}..."
docker exec "$CONTAINER" sh -c 'rm -f /tmp/jiti/*.cjs'

echo "==> Restarting ${CONTAINER}..."
docker restart "$CONTAINER" >/dev/null

echo "==> Waiting ${WAIT_SECS}s for gateway to be ready..."
sleep "$WAIT_SECS"

# Verify the container is running
if docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  echo "==> Gateway is running."
else
  echo "!!! Gateway is NOT running — check docker logs ${CONTAINER}" >&2
  exit 1
fi
