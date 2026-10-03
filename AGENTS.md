# Pi Hermes Memory Extension

## Project Overview

This is a Pi coding agent extension that brings Hermes-style persistent memory and a learning loop to any Pi user. After `pi install`, users get persistent memory across sessions, a background learning loop, and session-end flush.

This checkout is the forwardport of the local fork onto upstream `0.9.9`; retained fork contracts and their evidence are recorded in `docs/FORK_LEDGER.md`. The user-facing behavior and configuration are documented in `README.md`.

## Architecture

- **Language**: TypeScript (loaded via jiti, no compilation needed at runtime)
- **Runtime**: Pi extension API (`@earendil-works/pi-coding-agent`)
- **Storage**: Markdown remains the editable source of truth; SQLite stores searchable memory and indexed session history under the configured Pi data directory
- **Entry point**: `src/index.ts` — registers tools, event handlers, and commands

## Key Files

| File | Purpose |
|---|---
| `src/index.ts` | Extension entry point — wires all components together |
| `src/types.ts` | Shared TypeScript interfaces + `getMessageText()` helper |
| `src/constants.ts` | Prompts, defaults, delimiter |
| `src/store/memory-store.ts` | Core `MemoryStore` class — CRUD, persistence, frozen snapshot |
| `src/store/content-scanner.ts` | `scanContent()` — injection/exfiltration detection |
| `src/tools/memory-tool.ts` | `registerMemoryTool()` — LLM tool definition |
| `src/handlers/background-review.ts` | `setupBackgroundReview()` — learning loop via `pi.exec` |
| `src/handlers/session-flush.ts` | `setupSessionFlush()` — pre-compaction/shutdown flush |
| `src/handlers/insights.ts` | `registerInsightsCommand()` — `/memory-insights` command |
| `README.md` | User-facing behavior, configuration, migration and search guarantees |
| `docs/ROADMAP.md` | Full roadmap with Hermes competitive analysis + gap analysis |
| `docs/FORK_LEDGER.md` | Forwardport contracts, decisions and current verification evidence |

## Design Decisions

1. **Frozen snapshot** — Memory is injected into system prompt once at session start, never mutated mid-session (preserves Pi's prompt caching)
2. **Atomic writes** — Temp file + `fs.rename()` for crash safety
3. **`pi.exec()` for background review** — Stays within Pi's intended extension API
4. **`§` delimiter** — Same as Hermes for consistency
5. **SQLite search is bounded and isolated** — indexed reads use readonly/query-only workers; Markdown remains the durable editable source

## Hermes Source Reference

The implementation is ported from the Hermes agent harness. See `PLAN.md` → "Hermes Source File Reference Map" for exact files and line ranges to read.

## Roadmap & Task Tracking

- **Roadmap**: `docs/ROADMAP.md` — historical roadmap and Hermes gap analysis
- **v0.1 tasks** (complete): `docs/0.1/TASKS.md`
- **Current contract**: `docs/FORK_LEDGER.md` — forwardport scope, preserved guarantees and release gates

**Workflow:**
1. Read `docs/FORK_LEDGER.md` and the relevant section of `README.md`
2. Reproduce the relevant contract with the project test/check commands
3. Implement the smallest complete change
4. Update the ledger and documentation with current evidence
5. Inspect tracked and untracked changes before committing

**Before starting work, read `docs/FORK_LEDGER.md` and the relevant project documentation to identify the active contract and its gates.**

## Git Workflow

- After successful verification, automatically create the relevant commit or commits unless the user explicitly asks to leave changes uncommitted.
- Before finishing, inspect remaining tracked and untracked changes and commit completed work in separate coherent commits; never commit secrets, disposable artifacts, or generated noise.

## Development

```bash
# Type check
npm run check

# Test locally
pi -e ./src/index.ts
```

## Installation (for users)

```bash
pi install npm:pi-hermes-memory

# or from git
pi install git:github.com/chandra447/pi-hermes-memory
```
