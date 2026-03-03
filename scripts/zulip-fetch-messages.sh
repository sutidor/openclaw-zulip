#!/usr/bin/env bash
# Fetch messages from a Zulip stream, with optional topic and date filters.
#
# Usage:
#   ./zulip-fetch-messages.sh                          # last 50 from general
#   ./zulip-fetch-messages.sh -s general -t test       # from general > test topic
#   ./zulip-fetch-messages.sh -n 100                   # last 100 messages
#   ./zulip-fetch-messages.sh -s general --today       # today's messages only
#   ./zulip-fetch-messages.sh -s general --since 2026-02-24
#   ./zulip-fetch-messages.sh -a <id> -s general         # fetch as a named account
#   ./zulip-fetch-messages.sh --raw                    # output raw JSON
#
# Requires: jq, curl

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Defaults
ACCOUNT="default"
STREAM="general"
TOPIC=""
NUM=50
SINCE=""
TODAY=false
RAW=false

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \?//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--account) ACCOUNT="$2"; shift 2 ;;
    -s|--stream)  STREAM="$2"; shift 2 ;;
    -t|--topic)   TOPIC="$2"; shift 2 ;;
    -n|--num)     NUM="$2"; shift 2 ;;
    --since)      SINCE="$2"; shift 2 ;;
    --today)      TODAY=true; shift ;;
    --raw)        RAW=true; shift ;;
    -h|--help)    usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

# shellcheck source=zulip-env.sh
source "$SCRIPT_DIR/zulip-env.sh" "$ACCOUNT"

# Build narrow filter
NARROW="[{\"operator\":\"stream\",\"operand\":\"$STREAM\"}"
if [[ -n "$TOPIC" ]]; then
  NARROW="${NARROW},{\"operator\":\"topic\",\"operand\":\"$TOPIC\"}"
fi
NARROW="${NARROW}]"

# Fetch messages
RESPONSE=$(curl -sS -u "$ZULIP_AUTH" \
  -G "$ZULIP_BASE_URL/api/v1/messages" \
  --data-urlencode "anchor=newest" \
  --data-urlencode "num_before=$NUM" \
  --data-urlencode "num_after=0" \
  --data-urlencode "narrow=$NARROW" \
  --data-urlencode "apply_markdown=false")

# Check for errors
if echo "$RESPONSE" | jq -e '.result == "error"' &>/dev/null; then
  echo "ERROR: $(echo "$RESPONSE" | jq -r '.msg')" >&2
  exit 1
fi

# Date filtering
if [[ "$TODAY" == true ]]; then
  SINCE="$(date +%Y-%m-%d)"
fi

if [[ -n "$SINCE" ]]; then
  SINCE_EPOCH=$(date -d "$SINCE" +%s 2>/dev/null || date -jf "%Y-%m-%d" "$SINCE" +%s 2>/dev/null)
  RESPONSE=$(echo "$RESPONSE" | jq --argjson since "$SINCE_EPOCH" \
    '.messages |= [.[] | select(.timestamp >= $since)]')
fi

if [[ "$RAW" == true ]]; then
  echo "$RESPONSE" | jq '.messages'
  exit 0
fi

# Formatted output
echo "$RESPONSE" | jq -r '
  .messages[] |
  "\(.timestamp | todate)  [\(.sender_full_name)\(if (.sender_email | test("bot")) then " [BOT]" else "" end)]  #\(.display_recipient) > \(.subject)\n  \(.content)\n"
'
