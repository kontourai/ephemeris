# Agent Guide

## Source Of Truth

- Product/domain context: `CONTEXT.md`.
- Full project behavior and public API: `README.md`.
- Agent-facing repo instructions: `AGENTS.md`.
- Broad verification: `npm test`.

## Match Checks To Change Type

- Docs/interface-only changes: inspect the Markdown diff and run `npm test` before merge readiness.
- TypeScript/API changes: run `npm run typecheck` plus the focused test path that covers the touched code.
- Package or behavior changes: run `npm test`; it builds first, then runs deterministic `node --test` tests.
- Generated output: do not edit `dist/` or other generated files by hand.

## Useful Commands

- `npm test` - broad repo verification (`npm run build` plus `node --test tests/node/*.test.mjs`).
- `npm run typecheck` - focused TypeScript check without emitting build output.
- `npm run build` - compile TypeScript into `dist/`.
- `npm run test:node` - run the node test suite against an existing build.
- `npm run example` - build and run the ManualClock demo.

## Repo Boundaries

- Ephemeris is the external freshness scheduler / event-bridge for the Kontour suite.
- Preserve the invariant that it triggers Flow and never authors TrustBundles, ledgers, `fresh`, `stale`, or `revoked` state.
- Reuse README vocabulary for Hachure, Surface, Flow, Store, Source, Trigger, and deadlines.
- Keep docs-only interface work limited to `AGENTS.md` and `CONTEXT.md` unless the task explicitly calls for more.

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `veritas readiness` and address any FAIL lines before finishing.
<!-- veritas:governance-block:end -->
