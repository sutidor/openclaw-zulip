# openclaw-zulip

Zulip channel plugin for [OpenClaw](https://docs.openclaw.ai) — connects AI agents to Zulip conversations.

## What it does

- Monitors Zulip streams for messages and routes them to OpenClaw agents
- Supports multiple bot accounts with independent configuration
- Mention-gated and always-reply modes for flexible routing
- Emoji reaction workflows for visual processing feedback
- File upload handling for attachments
- Automatic recovery from connection failures with backoff

## Project structure

```text
src/        Source code (TypeScript)
e2e/        End-to-end scenarios against a live Zulip instance
scripts/    Diagnostic helpers for querying Zulip (see scripts/README.md)
```

### Workflow docs

Development workflow artifacts (CRs, PRDs, specs, ADRs, tasks) are managed
separately at:

    /opt/openclaw-dev/docs/openclaw-zulip/

See `WORKFLOW.md` in that directory for how they fit together.

## Install

```bash
openclaw plugins install /path/to/openclaw-zulip
```

## Configuration

The plugin reads Zulip credentials from your OpenClaw config (`~/.openclaw/openclaw.json`).

## Development

```bash
npm install
npm test
```

Tests live next to source files (`foo.test.ts` beside `foo.ts`) and reference behavioral specs via `// spec: area.md ## Section` comments. Spec files are in the docs directory.

### E2E tests

End-to-end scenarios run against a live Zulip instance on a dedicated
`e2e-tests` stream.

```bash
cp .env.e2e.example .env.e2e   # fill in credentials
npm run test:e2e               # all scenarios
npm run test:e2e r4 r6         # specific scenarios
```

See `e2e/` for scenario files and helpers.

No local `tsconfig.json` — the OpenClaw gateway build system compiles this plugin.

## Contributing

This project uses spec-driven development. Before writing code:

1. Ensure the behavior is specified in the docs `spec/` directory
2. Check `tasks/` in the docs for active work items
3. Follow the workflow in `WORKFLOW.md`
