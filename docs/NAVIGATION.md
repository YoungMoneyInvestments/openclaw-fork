# OpenClaw Navigation

Use this map before broad search. OpenClaw is a local-first personal AI assistant with gateway, apps, UI, plugins, skills, and extensions.

## Start Here

| Need | Open |
|------|------|
| Project overview | `README.md` |
| Root agent rules | `AGENTS.md` |
| Claude-facing notes | `CLAUDE.md` |
| Docs guide | `docs/AGENTS.md` |
| Extensions guide | `extensions/AGENTS.md` |
| Scripts guide | `scripts/AGENTS.md` |
| UI guide | `ui/AGENTS.md` |
| Existing docs index | `docs/INDEX.md` |

## Top-Level Map

| Path | Purpose |
|------|---------|
| `src/` | Main OpenClaw source |
| `extensions/` | Extension/plugin code |
| `apps/` | Application surfaces |
| `ui/` | Frontend UI |
| `packages/` | Shared packages |
| `scripts/` | Automation and maintenance scripts |
| `skills/` | Built-in skills |
| `docs/` | Documentation site/content |
| `test/`, `qa/` | Tests and QA assets |

## Commands

Check package manager config before running commands. Common surfaces use Node 22+/24 and workspace package scripts.

## Search Rules

- app/source behavior: `rg "<name>" src apps packages`
- extension behavior: `rg "<name>" extensions`
- UI behavior: `rg "<name>" ui`
- docs: `rg "<name>" docs`

Avoid first-pass search in build outputs, generated timestamp files, caches, and dependency directories.

## Safety

- Do not mutate provider credentials or channel integrations without approval.
- Physically test changed user-facing UI flows.
- For channel integrations, verify with local/simulated flow before claiming working.
