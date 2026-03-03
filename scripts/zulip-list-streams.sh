#!/usr/bin/env bash
# List streams on the Zulip instance with subscriber counts.
#
# Usage:
#   ./zulip-list-streams.sh             # all streams
#   ./zulip-list-streams.sh --subscribed # only streams the bot is subscribed to
#   ./zulip-list-streams.sh --raw        # raw JSON
#   ./zulip-list-streams.sh -a <id>        # authenticate as a named account
#
# Requires: jq, curl

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ACCOUNT="default"
SUBSCRIBED=false
RAW=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--account)   ACCOUNT="$2"; shift 2 ;;
    --subscribed)   SUBSCRIBED=true; shift ;;
    --raw)          RAW=true; shift ;;
    -h|--help)      sed -n '2,10p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# shellcheck source=zulip-env.sh
source "$SCRIPT_DIR/zulip-env.sh" "$ACCOUNT"

if [[ "$SUBSCRIBED" == true ]]; then
  ENDPOINT="$ZULIP_BASE_URL/api/v1/users/me/subscriptions"
  JQ_ROOT=".subscriptions"
else
  ENDPOINT="$ZULIP_BASE_URL/api/v1/streams"
  JQ_ROOT=".streams"
fi

RESPONSE=$(curl -sS -u "$ZULIP_AUTH" "$ENDPOINT")

if echo "$RESPONSE" | jq -e '.result == "error"' &>/dev/null; then
  echo "ERROR: $(echo "$RESPONSE" | jq -r '.msg')" >&2
  exit 1
fi

if [[ "$RAW" == true ]]; then
  echo "$RESPONSE" | jq "$JQ_ROOT"
  exit 0
fi

echo "$RESPONSE" | jq -r "
  [${JQ_ROOT}[] ] | sort_by(.name)[] |
  [
    (.stream_id | tostring),
    .name,
    (.subscriber_count // 0 | tostring),
    (.description // \"-\" | gsub(\"\\n\"; \" \") | .[0:50])
  ] | @tsv
" | column -t -s $'\t' -N 'ID,NAME,SUBS,DESCRIPTION'
