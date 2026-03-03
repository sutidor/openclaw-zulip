#!/usr/bin/env bash
# Dump a full conversation timeline with reactions, showing who said what and when.
# Designed for debugging agent behavior, loops, and routing issues.
#
# Usage:
#   ./zulip-conversation-dump.sh                             # general > all topics, last 50
#   ./zulip-conversation-dump.sh -s general -t test          # specific topic
#   ./zulip-conversation-dump.sh --today                     # today only
#   ./zulip-conversation-dump.sh --since 2026-02-24          # since date
#   ./zulip-conversation-dump.sh -n 200                      # last 200 messages
#   ./zulip-conversation-dump.sh --show-reactions             # include reaction details
#   ./zulip-conversation-dump.sh --detect-loops               # highlight potential loops
#
# Requires: jq, curl

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ACCOUNT="default"
STREAM="general"
TOPIC=""
NUM=50
SINCE=""
TODAY=false
SHOW_REACTIONS=false
DETECT_LOOPS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--account)       ACCOUNT="$2"; shift 2 ;;
    -s|--stream)        STREAM="$2"; shift 2 ;;
    -t|--topic)         TOPIC="$2"; shift 2 ;;
    -n|--num)           NUM="$2"; shift 2 ;;
    --since)            SINCE="$2"; shift 2 ;;
    --today)            TODAY=true; shift ;;
    --show-reactions)   SHOW_REACTIONS=true; shift ;;
    --detect-loops)     DETECT_LOOPS=true; shift ;;
    -h|--help)          sed -n '2,13p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# shellcheck source=zulip-env.sh
source "$SCRIPT_DIR/zulip-env.sh" "$ACCOUNT"

# Build narrow
NARROW="[{\"operator\":\"stream\",\"operand\":\"$STREAM\"}"
if [[ -n "$TOPIC" ]]; then
  NARROW="${NARROW},{\"operator\":\"topic\",\"operand\":\"$TOPIC\"}"
fi
NARROW="${NARROW}]"

# Fetch
RESPONSE=$(curl -sS -u "$ZULIP_AUTH" \
  -G "$ZULIP_BASE_URL/api/v1/messages" \
  --data-urlencode "anchor=newest" \
  --data-urlencode "num_before=$NUM" \
  --data-urlencode "num_after=0" \
  --data-urlencode "narrow=$NARROW" \
  --data-urlencode "apply_markdown=false")

if echo "$RESPONSE" | jq -e '.result == "error"' &>/dev/null; then
  echo "ERROR: $(echo "$RESPONSE" | jq -r '.msg')" >&2
  exit 1
fi

# Date filter
if [[ "$TODAY" == true ]]; then
  SINCE="$(date +%Y-%m-%d)"
fi
if [[ -n "$SINCE" ]]; then
  SINCE_EPOCH=$(date -d "$SINCE" +%s 2>/dev/null || date -jf "%Y-%m-%d" "$SINCE" +%s 2>/dev/null)
  RESPONSE=$(echo "$RESPONSE" | jq --argjson since "$SINCE_EPOCH" \
    '.messages |= [.[] | select(.timestamp >= $since)]')
fi

MSG_COUNT=$(echo "$RESPONSE" | jq '.messages | length')

# Header
echo "============================================================"
echo "CONVERSATION DUMP: #$STREAM${TOPIC:+ > $TOPIC}"
echo "Messages: $MSG_COUNT | Fetched as: $ZULIP_EMAIL"
echo "============================================================"
echo ""

# Detect if sender is a bot (by email pattern)
is_bot_jq='(if (.sender_email | test("-bot@|bot@")) then true else false end)'

# Format each message
echo "$RESPONSE" | jq -r --argjson show_reactions "$SHOW_REACTIONS" "
  .messages[] |
  \"--- [\(.id)] \(.timestamp | todate) ---\" +
  \"\n  FROM: \(.sender_full_name) \(if ($is_bot_jq) then \"[BOT]\" else \"[HUMAN]\" end) <\(.sender_email)>\" +
  \"\n  TOPIC: \(.subject)\" +
  \"\n  CONTENT: \(.content | gsub(\"\\n\"; \"\\n           \"))\" +
  (if (\$show_reactions and (.reactions | length > 0)) then
    \"\n  REACTIONS: \" + ([.reactions[] | \":\(.emoji_name): by uid \(.user_id)\"] | join(\", \"))
  else \"\" end) +
  \"\n\"
"

# Loop detection
if [[ "$DETECT_LOOPS" == true ]]; then
  echo ""
  echo "============================================================"
  echo "LOOP DETECTION ANALYSIS"
  echo "============================================================"

  # Find consecutive bot-only message runs
  echo "$RESPONSE" | jq -r '
    .messages |
    # Tag each message as bot or human
    [.[] | {
      id: .id,
      sender: .sender_full_name,
      is_bot: (.sender_email | test("-bot@|bot@")),
      ts: (.timestamp | todate),
      content_preview: (.content | .[0:80])
    }] |

    # Find runs of consecutive bot messages
    reduce .[] as $msg (
      {runs: [], current_run: [], in_bot_run: false};

      if $msg.is_bot then
        if .in_bot_run then
          .current_run += [$msg]
        else
          .in_bot_run = true |
          .current_run = [$msg]
        end
      else
        if .in_bot_run and (.current_run | length >= 3) then
          .runs += [.current_run]
        else . end |
        .in_bot_run = false |
        .current_run = []
      end
    ) |

    # Catch final run
    if .in_bot_run and (.current_run | length >= 3) then
      .runs += [.current_run]
    else . end |

    if (.runs | length) == 0 then
      "No bot-only loops detected (threshold: 3+ consecutive bot messages)."
    else
      .runs | to_entries[] |
      "\nLOOP #\(.key + 1): \(.value | length) consecutive bot messages" +
      "\n  First: [\(.value[0].id)] \(.value[0].ts) \(.value[0].sender): \(.value[0].content_preview)" +
      "\n  Last:  [\(.value[-1].id)] \(.value[-1].ts) \(.value[-1].sender): \(.value[-1].content_preview)" +
      "\n  Participants: " + ([.value[].sender] | unique | join(", "))
    end
  '
fi

# Summary stats
echo ""
echo "============================================================"
echo "SUMMARY"
echo "============================================================"
echo "$RESPONSE" | jq -r '
  .messages |
  {
    total: length,
    by_sender: (group_by(.sender_full_name) | map({
      name: .[0].sender_full_name,
      count: length,
      is_bot: (.[0].sender_email | test("-bot@|bot@"))
    }) | sort_by(-.count)),
    topics: ([.[].subject] | unique)
  } |
  "Total messages: \(.total)" +
  "\nTopics: \(.topics | join(", "))" +
  "\n\nMessages by sender:" +
  (.by_sender | map(
    "\n  \(.name)\(if .is_bot then " [BOT]" else "" end): \(.count)"
  ) | join(""))
'
