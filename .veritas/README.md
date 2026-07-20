# Veritas Starter Kit

This repo was bootstrapped for `ephemeris` with a conservative starter kit for agent-guided development.

## Generated Files

- `.veritas/README.md`
- `.veritas/GOVERNANCE.md`
- `.veritas/repo-map.json`
- `.veritas/repo-standards/default.repo-standards.json`
- `.veritas/authority/default.authority-settings.json`

## Inferred Repo Shape

- Repo kind: `application`
- Source roots: `src/`
- Tooling roots: `none`
- Test roots: `tests/`
- GitHub workflows detected: `yes`
- Matching scripts seen: `test`, `build`

## What To Do Next

1. Confirm the inferred source/test roots match the real repo layout.
2. Replace the suggested evidenceCheck if a stronger project health command exists.
3. Keep uncertain requirements in Observe or Guide until evidence shows they should be required.

## Initialization Recommendation

- Mode: guided initialization artifact
- Repo kind: `application`
- Evidence Check: `npm test`
- Selected instruction targets: `AGENTS.md`



## Suggested Commands

```bash
npx @kontourai/veritas readiness --working-tree
npx @kontourai/veritas readiness --check coverage --working-tree
npx @kontourai/veritas integrations codex status
npx @kontourai/veritas attest bootstrap --actor <authority-id> --approval-ref <human-approval-reference> --non-interactive
```

If you prefer explicit paths:

```bash
npx @kontourai/veritas readiness --check evidence \
  --repo-map ./.veritas/repo-map.json \
  --repo-standards ./.veritas/repo-standards/default.repo-standards.json \
  package.json
```

## Suggested Evidence Check

`npm test`

## Work-Area Evidence Routing

This starter stays on the minimal single-check path by default. Work-area evidence routing can be added later if the repo grows multiple independently verified work areas.

## Why This Exists

The goal is to give developers and agents just-in-time repo guidance from day one, while keeping review and CI grounded in the same starter standards.
