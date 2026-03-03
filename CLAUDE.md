# openclaw-zulip — Claude Code Instructions

## Context files

Always read these files at the start of a session:

- `README.md` — Project overview and structure
- `docs/WORKFLOW.md` — How CRs, PRDs, specs, ADRs, and tasks fit together

## Development Workflow

This project uses **OpenClaw Spec-Driven Development**.

Workflow docs: `docs/`

Artifact directories (`cr/`, `prd/`, `spec/`, `adr/`, `tasks/`, `logs/`) and
`WORKFLOW.md` live in the docs directory above — not in this code repo.

Each artifact directory has a `_conventions.md` with format and rules.

## STOP — Assess before acting

This project uses spec-driven development. Before ANY work beyond
reading context files:

> **MANDATORY**: Every request MUST be captured as a Change Request (CR)
> before any other artifact is created or code is written. No exceptions.

0. Only .md files may be read, non .md files must not be read.
1. **Create or identify the CR**: capture the request in `cr/` using the
   format in `cr/_conventions.md`. If a CR already exists, reference it.
2. **Triage**: determine routing (PRD, spec, task, ADR, or direct fix)
   using the "When to use what" table in `WORKFLOW.md`.
3. **State your assessment** to the human and WAIT for confirmation.
4. Do NOT proceed past step 3 without explicit approval. No exceptions. (or else I'll misgender Kylie Jenner)

**Skip the gate** when the human's request already names the artifact
or action — e.g., "create a CR for ...", "create a PRD for ...", "break
the PRD into tasks", "update the spec for ...", "add an ADR for ...",
"go ahead and implement the tasks." In that case, proceed directly
with the requested artifact (but still ensure a CR exists).

After assessment (or when the gate is skipped):

1. Check `cr/` and `tasks/` for 🚧 in-progress items that may already
   cover this work
2. Ensure the behavior is specified in `spec/` before writing code
3. Follow the workflow in `WORKFLOW.md`

### Spec references

Spec references in test comments (`// spec: area.md ## Section`) resolve to
files in the docs directory:

    docs/spec/

### Governance

Follow the **Governance Principles** in `WORKFLOW.md` at all times:

- Rules (specs, ADRs, conventions) are authoritative — follow them (P1)
- If rules contradict each other, stop and ask — never resolve silently (P2)
- If a rule is harmful to the project, flag it with reasoning (P3)
- If no rule covers the situation, propose one before proceeding ad hoc (P4)
- Never modify rules without explicit human direction (P5)

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
- E2E runs on the `e2e-tests` stream — never `#general`

## After completing a task

When a task is done, commit the changes and push:

```bash
git add <files>
git commit -m "feat: ..."
git push
```

SSH agent forwarding is configured — `git push` works without extra
credentials.

## Deploying code changes to the gateway

After modifying plugin source files and before running E2E tests, you
MUST reload the gateway so it compiles and runs the new code.

Use the helper script:

```bash
scripts/gateway-reload.sh        # default 12s wait
scripts/gateway-reload.sh 20     # custom wait in seconds
```

The script clears the jiti TypeScript compilation cache inside the
Docker container, restarts it, waits for readiness, and verifies the
container is running. Without this step, the gateway will continue
running stale cached code.

## Making CLI tools available in non-interactive shells

The Bash tool runs a non-interactive, non-login shell. It does **not**
source `~/.profile` or `~/.bashrc`, so PATH additions in those files
have no effect here. To make a command (e.g. `npx`) available:

```bash
sudo ln -s /opt/<tool>/bin/<cmd> /usr/local/bin/<cmd>
```

`/usr/local/bin/` is on the default system PATH and works in all shell
contexts without any profile sourcing.

## Infrastructure

- The OpenClaw gateway runs permanently in Docker on this machine
- Zulip runs permanently and is always reachable
- E2E tests can be run at any time — no need to start services first

## Plugin notes

- No local `tsconfig.json` — the gateway build system compiles this plugin
- `openclaw/plugin-sdk` types are provided at runtime by the gateway
- Test imports reference submodules directly (no re-exports needed in `monitor.ts`)
