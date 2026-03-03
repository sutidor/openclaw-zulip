#!/usr/bin/env bash
# List all users/bots on the Zulip instance.
#
# Usage:
#   ./zulip-list-users.sh              # all active users
#   ./zulip-list-users.sh --bots       # bots only
#   ./zulip-list-users.sh --humans     # humans only
#   ./zulip-list-users.sh --raw        # raw JSON
#   ./zulip-list-users.sh -a <id>        # authenticate as a named account
#
# Requires: jq, curl

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ACCOUNT="default"
FILTER="all"
RAW=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--account) ACCOUNT="$2"; shift 2 ;;
    --bots)       FILTER="bots"; shift ;;
    --humans)     FILTER="humans"; shift ;;
    --raw)        RAW=true; shift ;;
    -h|--help)    sed -n '2,10p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# shellcheck source=zulip-env.sh
source "$SCRIPT_DIR/zulip-env.sh" "$ACCOUNT"

RESPONSE=$(curl -sS -u "$ZULIP_AUTH" "$ZULIP_BASE_URL/api/v1/users")

if echo "$RESPONSE" | jq -e '.result == "error"' &>/dev/null; then
  echo "ERROR: $(echo "$RESPONSE" | jq -r '.msg')" >&2
  exit 1
fi

# Apply filter
JQ_FILTER='.members[] | select(.is_active == true)'
case "$FILTER" in
  bots)   JQ_FILTER="$JQ_FILTER | select(.is_bot == true)" ;;
  humans) JQ_FILTER="$JQ_FILTER | select(.is_bot == false)" ;;
esac

if [[ "$RAW" == true ]]; then
  echo "$RESPONSE" | jq "[$JQ_FILTER]"
  exit 0
fi

# Formatted table using tab-separated jq output
echo "$RESPONSE" | jq -r "
  [$JQ_FILTER] | sort_by(.full_name)[] |
  [
    (.user_id | tostring),
    .full_name,
    (if .is_bot then \"BOT\" else \"\" end),
    (.role | tostring),
    .email
  ] | @tsv
" | column -t -s $'\t' -N 'ID,NAME,BOT?,ROLE,EMAIL'
