#!/usr/bin/env bash
# Shared Zulip environment loader for helper scripts.
# Sources credentials from openclaw.json for the requested account.
#
# Usage (from other scripts):
#   source "$(dirname "$0")/zulip-env.sh"                # loads default account
#   source "$(dirname "$0")/zulip-env.sh" <account-id>   # loads a named account
#
# Exports: ZULIP_BASE_URL, ZULIP_EMAIL, ZULIP_API_KEY, ZULIP_AUTH (curl -u arg)

set -euo pipefail

OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
ACCOUNT="${1:-default}"

if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
  echo "ERROR: openclaw.json not found at $OPENCLAW_CONFIG" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed" >&2
  exit 1
fi

_zulip_cfg() {
  jq -r "$1" "$OPENCLAW_CONFIG"
}

if [[ "$ACCOUNT" == "default" ]]; then
  # Top-level zulip config (default account)
  ZULIP_BASE_URL="$(_zulip_cfg '.channels.zulip.baseUrl')"
  ZULIP_EMAIL="$(_zulip_cfg '.channels.zulip.email')"
  ZULIP_API_KEY="$(_zulip_cfg '.channels.zulip.apiKey')"
else
  # Named account from channels.zulip.accounts[]
  _acct_json="$(jq -r --arg id "$ACCOUNT" \
    '.channels.zulip.accounts[] | select(.accountId == $id)' \
    "$OPENCLAW_CONFIG")"

  if [[ -z "$_acct_json" || "$_acct_json" == "null" ]]; then
    echo "ERROR: Zulip account '$ACCOUNT' not found in config" >&2
    exit 1
  fi

  ZULIP_BASE_URL="$(echo "$_acct_json" | jq -r '.baseUrl')"
  ZULIP_EMAIL="$(echo "$_acct_json" | jq -r '.email')"
  ZULIP_API_KEY="$(echo "$_acct_json" | jq -r '.apiKey')"
fi

ZULIP_AUTH="${ZULIP_EMAIL}:${ZULIP_API_KEY}"

export ZULIP_BASE_URL ZULIP_EMAIL ZULIP_API_KEY ZULIP_AUTH
