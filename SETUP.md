# Zulip Setup Guide

How to set up a Zulip organization for OpenClaw from scratch.

## Prerequisites

- Zulip >=11 organization with admin access
- OpenClaw gateway installed and running in Docker
- `jq` and `curl` on the host machine

## 1. Create Streams

Create these streams in your Zulip organization. The emoji prefix is part of
the stream name — it must match exactly in the OpenClaw config.

| Stream | Description |
|--------|-------------|
| `👑 Executive` | Strategy, priorities, and cross-department coordination |
| `📌 Personal` | Calendar, email, and personal tasks |
| `💰 Sales` | Pipeline, leads, outreach, and deals |
| `📦 Delivery` | Active projects, client work, and handoffs |
| `💻 Dev` | Software development, PRs, and code review |
| `📊 Backoffice` | Invoicing, payments, contracts, taxes, and compliance |
| `⚙️ DevOps` | Infrastructure, incidents, and deployments |
| `📣 Marketing` | Content, campaigns, social media, and brand |
| `🧪 Incubator` | New ideas, experiments, MVPs, and business strategy |
| `🔥 Firehose` | All cross-agent handoffs and audit trail (read-only) |
| `💬 General` | General discussion (not monitored by bots) |
| `🔍 E2E Tests` | Automated end-to-end test runs |

## 2. Create Bot Accounts

Create these bots via **Organization settings > Bots**. Each bot has a Zulip
role that determines its permissions.

| Bot Name | Email Pattern | Role | Purpose |
|----------|--------------|------|---------|
| Chief of Staff | `<prefix>-bot@<domain>` | Organization owner (100) | Coordinator — routes all unmentioned messages |
| Personal Assistant | `<prefix>-bot@<domain>` | Guest (400) | Personal tasks, calendar, email |
| Prospector | `<prefix>-bot@<domain>` | Guest (400) | Lead sourcing and qualification |
| Closer | `<prefix>-bot@<domain>` | Guest (400) | Sales conversations and deal closing |
| Fulfillment | `<prefix>-bot@<domain>` | Guest (400) | Project delivery |
| Dev | `<prefix>-bot@<domain>` | Guest (400) | Software development |
| DevOps | `<prefix>-bot@<domain>` | Guest (400) | Infrastructure and deployments |
| Accountant | `<prefix>-bot@<domain>` | Guest (400) | Invoicing and financial management |
| Legal | `<prefix>-bot@<domain>` | Guest (400) | Contracts and compliance |
| Marketing | `<prefix>-bot@<domain>` | Guest (400) | Content and campaigns |
| Strategist | `<prefix>-bot@<domain>` | Guest (400) | Business incubation and KPI oversight |
| Claude Code | `<prefix>-bot@<domain>` | Member (200) | E2E test sim-user (not an agent) |

**Roles:**
- **100 (Owner):** The coordinator needs full access to monitor all streams
- **200 (Member):** The test bot needs enough access to send messages
- **400 (Guest):** Specialists have minimal permissions — only their assigned streams

## 3. Stream Subscriptions

Subscribe each bot to its assigned streams.

| Bot | Streams |
|-----|---------|
| Chief of Staff (coordinator) | All 10 main streams + `🔍 E2E Tests` |
| Personal Assistant | `📌 Personal`, `🔍 E2E Tests` |
| Prospector | `💰 Sales` |
| Closer | `💰 Sales` |
| Fulfillment | `📦 Delivery` |
| Dev | `💻 Dev` |
| DevOps | `⚙️ DevOps` |
| Accountant | `📊 Backoffice` |
| Legal | `📊 Backoffice` |
| Marketing | `📣 Marketing` |
| Strategist | `🧪 Incubator` |
| Claude Code | `🔍 E2E Tests` |

Subscribe via API:

```bash
curl -u "<bot-email>:<api-key>" \
  https://<zulip-url>/api/v1/users/me/subscriptions \
  -d 'subscriptions=[{"name": "<stream-name>"}]'
```

## 4. Configure openclaw.json

Add the Zulip channel configuration to `~/.openclaw/openclaw.json`:

```jsonc
{
  "channels": {
    "zulip": {
      "enabled": true,
      "baseUrl": "https://<zulip-url>",
      "email": "<coordinator-email>",
      "apiKey": "<coordinator-api-key>",
      "streams": [
        "👑 Executive", "📌 Personal", "💰 Sales", "📦 Delivery",
        "💻 Dev", "📊 Backoffice", "⚙️ DevOps", "📣 Marketing",
        "🧪 Incubator", "🔥 Firehose"
      ],
      "alwaysReply": true,
      "reactions": { "enabled": true, "workflow": { "enabled": true } },
      "accounts": {
        "default": {
          "name": "Chief of Staff",
          "email": "<coordinator-email>",
          "apiKey": "<coordinator-api-key>",
          "streams": ["👑 Executive", "📌 Personal", "💰 Sales",
                      "📦 Delivery", "💻 Dev", "📊 Backoffice",
                      "⚙️ DevOps", "📣 Marketing", "🧪 Incubator",
                      "🔥 Firehose", "🔍 E2E Tests"],
          "alwaysReply": true
        },
        "<specialist-id>": {
          "name": "<Specialist Name>",
          "email": "<specialist-email>",
          "apiKey": "<specialist-api-key>",
          "streams": ["<assigned-stream>"],
          "alwaysReply": false
        }
        // ... repeat for each specialist
      }
    }
  }
}
```

**Important:** Stream names must match the actual Zulip stream names exactly,
including emoji prefixes. The monitor registers event queues using
`[["channel", <stream-name>]]` narrows which require exact string matching.

## 5. Agent Bindings

Map each Zulip account to an OpenClaw agent in the `bindings` array:

```jsonc
{
  "bindings": [
    { "agentId": "chief-of-staff", "match": { "channel": "zulip", "accountId": "default" } },
    { "agentId": "pa",             "match": { "channel": "zulip", "accountId": "pa" } },
    { "agentId": "prospector",     "match": { "channel": "zulip", "accountId": "prospector" } }
    // ... repeat for each specialist
  ]
}
```

## 6. Agent Workspaces

Each agent needs a workspace directory at `~/.openclaw/workspace-<agent-id>/`
with these files:

| File | Purpose |
|------|---------|
| `SOUL.md` | Core personality and behavior rules |
| `AGENTS.md` | Workspace conventions and session protocol |
| `IDENTITY.md` | Role-specific identity (from `docs/core/agents/<id>.md`) |
| `TOOLS.md` | Local tool notes |
| `USER.md` | Info about the human operator |
| `HEARTBEAT.md` | Periodic task checklist |
| `BOOTSTRAP.md` | First-run onboarding script |

The `IDENTITY.md` for each agent should contain the role description from
`docs/core/agents/<agent-id>.md`.

## 7. E2E Testing

Copy the example config and fill in credentials:

```bash
cp .env.e2e.example .env.e2e
# Edit .env.e2e with real credentials
```

Required variables:

| Variable | Description |
|----------|-------------|
| `E2E_ZULIP_URL` | Zulip instance base URL |
| `E2E_SIM_USER_EMAIL` | Claude Code bot email (acts as human) |
| `E2E_SIM_USER_API_KEY` | Claude Code bot API key |
| `E2E_STREAM` | Test stream (use `🔍 E2E Tests`) |
| `E2E_COORDINATOR_DISPLAY_NAME` | Coordinator Zulip display name |
| `E2E_COORDINATOR_EMAIL` | Coordinator bot email |
| `E2E_SPECIALIST_DISPLAY_NAME` | Specialist Zulip display name |
| `E2E_SPECIALIST_EMAIL` | Specialist bot email |

Run tests:

```bash
npm run test:e2e          # all scenarios
npm run test:e2e r1 r4    # specific scenarios
```

## 8. Gateway Reload

After any config change, reload the gateway:

```bash
scripts/gateway-reload.sh        # default 30s wait
scripts/gateway-reload.sh 20     # custom wait
```

Verify monitors started:

```bash
docker logs openclaw-openclaw-gateway-1 --since 60s 2>&1 | grep zulip
```
