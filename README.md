# Mode Manager Extension

Canonical Pi mode manager for mutually exclusive modes with mode-specific tools, context, skill guidance, and a shared visual panel.

## Commands

- `/mode status` — show active mode
- `/mode ask` — read-only Q&A mode
- `/mode plan` — read-only planning mode with plan-file writes and todo breakdowns
- `/mode review` — read-only review/findings mode
- `/mode debug` — hypothesis-driven debug mode; safe diagnostics/tests only
- `/mode docs` — documentation-only writing mode
- `/mode deploy` — read-only deployment readiness/checklist mode
- `/mode execute` — normal implementation mode
- `/mode off` — restore previous tools and clear mode panel

Compatibility aliases:

- `/ask`, `/ask on`, `/ask off`, `/ask status`
- `/plan draft`, `/plan validate`, `/plan revise`, `/plan approve`, `/plan execute`, `/plan execute force`, `/plan save <name>`, `/plan tasks`, `/plan memory`
- `/plan bug|feature|refactor|e2e|migration`

## Build setup

Install dev dependencies and run the TypeScript checks/build:

```bash
npm install
npm run typecheck
npm run build
```

The repo includes a small `types/` shim so the extension source can be checked in isolation.

## CLI

```bash
pi --start-mode ask
pi --start-mode plan
pi --start-mode review
pi --start-mode debug
pi --start-mode docs
pi --start-mode deploy
pi --start-mode execute
```

## Mode policies

| Mode | Writes | Bash | Tasks | Context |
|---|---|---|---|---|
| ask | none | read-only inspection | blocked | answer only |
| plan | `plans/**/*.md` | read-only inspection | todo allowed | structured plans |
| review | none | read-only inspection | blocked | findings only |
| debug | none | inspection + common tests | todo allowed | hypothesis/evidence |
| docs | `.md`, `.mdx`, `.rst` docs | read-only inspection | optional | docs only |
| deploy | none | read-only inspection | blocked | deploy checklist |
| execute | normal/default | unrestricted | allowed | implementation |

## Visual panel

The extension renders one shared above-editor panel showing active mode, safety policy, tools, recommended skills, next action, and switch hints.

## Old extensions

Standalone `ask-mode` and `plan-mode` have been moved to `extensions.disabled/` to avoid duplicate flags, widgets, commands, and context injection.

## Validation

Useful checks:

```bash
pi --help | rg -- '--start-mode|--ask|--plan'
pi --start-mode ask -p --no-context-files 'Use write tool to create /tmp/ask-test.md'
pi --start-mode plan -p --no-context-files 'Use bash to run: touch /tmp/plan-test'
```

Expected:

- `--start-mode` appears
- old `--ask` and `--plan` flags do not appear
- ask mode blocks writes/tasks
- plan mode blocks implementation writes and unsafe bash

## Doctor and config

Diagnostics:

```text
/mode doctor
```

Reload editable config without restarting Pi:

```text
/mode reload-config
```

Config file:

```text
~/.pi/agent-work/extensions/mode-manager/config.json
```

Example:

```json
{
  "docsRoots": ["docs", "plans", "."],
  "docsExtensions": [".md", ".mdx", ".rst"],
  "confirmExecuteFromModes": ["ask", "review", "debug", "deploy"],
  "extraSafeBashPatterns": []
}
```

## Safer execute switching

Switching from `ask`, `review`, `debug`, or `deploy` to `execute` asks for confirmation in UI sessions before normal implementation tools are restored.

## Autocomplete

The `/mode`, `/ask`, and `/plan` commands provide argument completions with descriptions where supported by Pi.

## Plan index

`/plan save <name>` now asks the agent to update `plans/index.md` with the saved plan metadata.

## Locking and thinking levels

Prevent accidental mode switches:

```text
/mode lock
/mode unlock
```

Mode-specific thinking levels are configurable through `modeThinkingLevels` in `config.json`:

```json
{
  "modeThinkingLevels": {
    "ask": "medium",
    "plan": "high",
    "review": "high",
    "debug": "high",
    "docs": "medium",
    "deploy": "medium",
    "execute": "medium"
  }
}
```

The previous thinking level is restored when `/mode off` is used.

## Audit trail

Mode transitions are persisted as custom session entries with `customType: "mode-manager-audit"`, including timestamp, previous mode, next mode, reason, plan state, plan kind, and lock state.

## Mode skills

Companion skills live under:

```text
~/.pi/agent-work/skills/modes/
```

Available mode skills:

- `mode-ask`
- `mode-plan`
- `mode-review`
- `mode-debug`
- `mode-docs`
- `mode-deploy`

They provide lightweight workflow guidance while the extension enforces tools and context.

## Extended plan workflow commands

The `/plan` alias includes additional helpers for managing a plan lifecycle without leaving the mode-manager:

- `/plan preflight` — read-only execute-readiness review
- `/plan diff` — compare latest plan to previous saved/approved plan where available
- `/plan review` — critique the plan for gaps and risks
- `/plan pr` — draft a PR description from the approved plan
- `/plan deploy` — create deployment/post-deploy checklist
- `/plan graph` — produce Mermaid task dependency graph
- `/plan evidence` — create per-task completion evidence checklist
- `/plan index` — update `plans/index.md` from saved plans

These helpers send follow-up instructions to the agent and preserve the active mode policy.

## Additional diagnostics

Additional `/mode` diagnostics:

- `/mode history` — show recent mode transition audit entries
- `/mode tools` — show active/profile/blocked tools and policies
- `/mode config` — show loaded config JSON and path
- `/mode reset` — clear mode state, unlock, restore tools/thinking

`/mode doctor` also reports whether old active `ask-mode` or `plan-mode` extension directories exist.

## Regression smoke tests

Run the mode policy smoke harness after Pi upgrades or mode-manager changes:

```bash
~/.pi/agent-work/extensions/mode-manager/scripts/smoke-test.sh
```

The harness runs Pi non-interactively with the local extension and validates that:

- `--start-mode` is registered
- ask mode blocks writes
- plan/debug modes block destructive bash
- docs mode blocks non-doc writes
- review mode blocks todo usage

Useful environment variables:

- `PI_CMD=/path/to/pi` — choose a Pi binary
- `EXTENSION_PATH=/path/to/index.ts` — test a specific extension copy
- `KEEP_MODE_MANAGER_SMOKE=1` — keep the temporary smoke-test workspace for inspection

## Per-project config

Mode-manager can merge a trusted repo-local config from:

```text
.pi/mode-manager.json
```

Merge order:

```text
defaults → extension config.json → trusted project .pi/mode-manager.json
```

Project config is loaded only when Pi considers the project trusted, for example when started with `--approve` or trusted through the TUI. Use `/mode reload-config` after editing config files.

Example:

```json
{
  "docsRoots": ["docs", "runbooks", "plans"],
  "docsExtensions": [".md", ".mdx", ".rst"],
  "extraSafeBashPatterns": ["^\\s*make\\s+docs-check\\b"],
  "modeThinkingLevels": {
    "plan": "high",
    "review": "high"
  }
}
```

Inspect the active merge with:

```text
/mode config
/mode doctor
```

## Panel density

The mode panel supports two density levels:

```text
/mode compact
/mode full
```

- `compact` shows a single-line status panel with mode, write policy, bash policy, lock state, and the command to restore full view.
- `full` shows the detailed mode panel with focus, tools, skills, next action, lock, and thinking level.

The selected density is persisted in session state. `/mode reset` restores full panel density.

## Mode presets

Save, list, apply, and delete named mode presets:

```text
/mode preset save <name>
/mode preset <name>
/mode presets
/mode preset delete <name>
```

A preset captures the current mode, plan kind/state, panel density, and thinking level. Presets are stored next to the extension in `presets.json` and are local to this Pi installation.

Examples:

```text
/mode review
/mode compact
/mode preset save compact-review
/mode preset compact-review
```

## Autocomplete polish

Autocomplete includes descriptions for top-level mode commands and nested helpers:

- `/mode preset ...` suggests `list`, `save`, `delete`, and saved preset names.
- `/mode presets` lists saved presets.
- `/plan execute ...` suggests `force`.

Descriptions use Pi's `AutocompleteItem.description` field.

## Optional OpenViking context backend

OpenViking can complement mode-manager as an optional context database, but it is not required for mode enforcement.

Recommended use:

- connect OpenViking through its MCP endpoint (`/mcp`) when available
- use OpenViking for mode-specific retrieval of memories, resources, and skills
- keep write/bash/tool enforcement inside the Pi mode-manager extension

Useful OpenViking surfaces:

- MCP tools: `search`, `read`, `list`, `store`, `add_resource`, `grep`, `glob`, `code_outline`, `code_search`, `code_expand`, `health`
- CLI: `ov find`, `ov search`, `ov read`, `ov add-resource`
- REST: `/api/v1/search/find`, `/api/v1/search/search`, `/api/v1/content/read`

Do not store OpenViking API keys in task memory, presets, plans, or mode-manager config. If implemented later, `/mode context ...` should be a thin helper around MCP/CLI guidance, not a hard dependency.
