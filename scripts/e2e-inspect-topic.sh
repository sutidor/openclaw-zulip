#!/usr/bin/env bash
# Inspect messages in an E2E test topic.
#
# Usage:
#   ./e2e-inspect-topic.sh <topic-name>       # show formatted messages
#   ./e2e-inspect-topic.sh <topic-name> --raw  # show raw JSON
#
# Uses credentials from .env.e2e (sim-user account).
# Requires: jq, curl

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env.e2e
ENV_FILE="$PROJECT_DIR/.env.e2e"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env.e2e not found at $ENV_FILE" >&2
  exit 1
fi
# Parse dotenv (handles unquoted values with spaces)
while IFS= read -r line; do
  line="${line%%#*}"      # strip comments
  line="${line#"${line%%[![:space:]]*}"}"  # trim leading whitespace
  line="${line%"${line##*[![:space:]]}"}"  # trim trailing whitespace
  [[ -z "$line" ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  export "$key=$value"
done < "$ENV_FILE"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <topic-name> [--raw]" >&2
  exit 1
fi

TOPIC="$1"
RAW=false
[[ "${2:-}" == "--raw" ]] && RAW=true

STREAM="${E2E_STREAM:-e2e-tests}"
AUTH="${E2E_SIM_USER_EMAIL}:${E2E_SIM_USER_API_KEY}"
BASE_URL="$E2E_ZULIP_URL"

NARROW=$(jq -n --arg s "$STREAM" --arg t "$TOPIC" \
  '[{"operator":"channel","operand":$s},{"operator":"topic","operand":$t}]')

RESPONSE=$(curl -sS -u "$AUTH" \
  -G "$BASE_URL/api/v1/messages" \
  --data-urlencode "anchor=newest" \
  --data-urlencode "num_before=20" \
  --data-urlencode "num_after=0" \
  --data-urlencode "narrow=$NARROW" \
  --data-urlencode "apply_markdown=false")

if echo "$RESPONSE" | jq -e '.result == "error"' &>/dev/null; then
  echo "ERROR: $(echo "$RESPONSE" | jq -r '.msg')" >&2
  exit 1
fi

if [[ "$RAW" == true ]]; then
  echo "$RESPONSE" | jq '.messages'
  exit 0
fi

echo "$RESPONSE" | jq -r '
  .messages[] |
  "ID:\(.id) from:\(.sender_email)\(
    if (.reactions | length) > 0
    then " reactions: \([.reactions[] | .emoji_name] | join(", "))"
    else ""
    end
  )\n  content: \(.content[:300])\n"
'
