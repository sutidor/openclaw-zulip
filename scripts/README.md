# Zulip Diagnostic Scripts

Helper scripts for querying the Zulip instance, debugging agent behavior, and analyzing conversations.

All scripts read credentials from `~/.openclaw/openclaw.json` automatically.

## Scripts

| Script | Purpose |
|--------|---------|
| `zulip-env.sh` | Shared credential loader — sourced by other scripts, not run directly |
| `zulip-fetch-messages.sh` | Fetch messages from a stream/topic with date filtering |
| `zulip-list-users.sh` | List users and bots on the instance |
| `zulip-list-streams.sh` | List streams with subscriber counts |
| `zulip-conversation-dump.sh` | Full conversation timeline with reactions, loop detection, and stats |

## Quick examples

```bash
# Who's on the instance?
./zulip-list-users.sh
./zulip-list-users.sh --bots

# What streams exist?
./zulip-list-streams.sh

# Today's conversation in general > test
./zulip-fetch-messages.sh -s general -t test --today

# Full diagnostic dump with loop detection
./zulip-conversation-dump.sh -s general -t test --today --show-reactions --detect-loops

# Last 200 messages as raw JSON (pipe to jq)
./zulip-fetch-messages.sh -n 200 --raw | jq '.[] | select(.sender_email | test("bot"))'

# Use a different bot account (account IDs come from openclaw.json)
./zulip-fetch-messages.sh -a <account-id> -s general
```

## Common flags

All scripts support:
- `-a, --account <id>` — authenticate as a named bot account from `openclaw.json`
- `--raw` — output raw JSON instead of formatted table
- `-h, --help` — show usage

Message scripts also support:
- `-s, --stream <name>` — stream to query (default: general)
- `-t, --topic <name>` — filter by topic
- `-n, --num <count>` — number of messages to fetch (default: 50)
- `--today` — filter to today's messages
- `--since <YYYY-MM-DD>` — filter from a specific date

## Requirements

- `jq` — JSON processor
- `curl` — HTTP client
- `column` — table formatter (part of util-linux)
