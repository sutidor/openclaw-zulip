# openclaw-zulip — Claude Code Instructions

## Private instructions

This project's workflow instructions, CR gate, governance, and operational
context live in a separate private location. **Read this file first:**

    /opt/claude-dev-workflow/projects/openclaw-zulip/CLAUDE-INSTRUCTIONS.md

## Coding standards

### Design principles

- **DRY** — Don't repeat yourself. Extract shared logic; but three similar
  lines beats a premature abstraction
- **SoC** — Separation of concerns. Each module owns one responsibility
- **YAGNI** — Don't build for hypothetical future needs
- **Single responsibility** — One reason to change per function/module
- **Least surprise** — APIs behave as callers expect; name things clearly
- **Fail fast** — Validate at boundaries, surface errors early
- **Explicit > implicit** — Prefer clear over clever
- **Minimal changes** — Only make necessary changes; keep diffs as small
  as possible. Don't refactor, add comments, or "improve" code outside the
  scope of the current task

### Language & modules

- TypeScript strict mode; no `any` unless unavoidable
- ESM imports with `.js` extensions; no CommonJS
- Prefer small focused files (<400 lines)

### Naming

- `camelCase` variables and functions
- `PascalCase` types and interfaces
- `UPPER_SNAKE_CASE` constants
- Semantic prefixes: `resolve*`, `normalize*`, `build*`, `create*`, `compute*`

### Types

- Prefer `type` aliases over `interface`
- Use `satisfies` for narrowing object literals
- Use discriminated unions over boolean flags
- Export types separately: `export type { Foo }`

### Functions & exports

- Named exports only — no default exports
- `function` declarations for top-level exports; arrow functions for callbacks
- Async/await exclusively — no `.then()` chains
- Use `AbortSignal` for cancellation, `finally` for cleanup

### Error handling

- Throw errors for exceptional cases; don't use exceptions for control flow
- Attach context properties to errors when useful (e.g., `err.status`)
- Use `.catch(() => undefined)` only for intentional silent swallowing

### Style

- Minimal comments — only where logic isn't self-evident
- Numeric separators for readability: `10_000` not `10000`
- Nullish coalescing (`??`) over logical OR (`||`) for defaults
- Destructuring for extraction; spread for merging
- `new Set()` / `new Map()` for collections, not plain objects

### Testing

- Tests live next to source (`foo.test.ts` beside `foo.ts`)
- Link tests to specs: `// spec: area.md ## Section`
- Test fixtures use obviously fake values (`"key"`, `bot@example.com`)
- E2E scenarios (`e2e/scenarios/`) validate features against a live Zulip
  instance — run `npm run test:e2e` after implementing behavioral changes
- E2E runs on the `🔍 E2E Tests` stream — never `#general`

## After completing a task

When a task is done, commit the changes and push:

```bash
git add <files>
git commit -m "feat: ..."
git push
```

## Deploying code changes to the gateway

After modifying plugin source files and before running E2E tests, you
MUST reload the gateway so it compiles and runs the new code.

```bash
~/scripts/gateway-reload.sh        # config reload (default 30s wait)
~/scripts/gateway-reload.sh 20     # custom wait in seconds
~/scripts/gateway-redeploy.sh      # full redeploy (image/compose changes + relay proxy)
```

## Plugin notes

- No local `tsconfig.json` — the gateway build system compiles this plugin
- `openclaw/plugin-sdk` types are provided at runtime by the gateway
- Test imports reference submodules directly (no re-exports needed in `monitor.ts`)
