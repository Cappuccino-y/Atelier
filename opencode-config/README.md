# opencode-config/

Bundled `opencode.json` agent definitions + persona markdown files. The
`scripts/deploy.ps1` (or `scripts/deploy.sh`) script copies these to
`~/.config/opencode/agents/` and merges `opencode-agents.template.json`
into your existing `~/.config/opencode/opencode.json`.

## Layout

```
opencode-config/
├── agents/
│   ├── atlas.md       # Orchestrator persona
│   ├── lens.md        # Reviewer persona (read-only)
│   ├── echo.md        # General support persona (read-only)
│   └── trainer.md     # Knowledge-base curator persona (read-only)
└── opencode-agents.template.json   # Partial opencode.json — agent.* block only
```

## Adding a new agent

1. Drop `<name>.md` in `agents/` with the standard front-matter:
   ```markdown
   ---
   description: One-line role
   mode: primary
   model: <provider>/<multimodal-model>
   temperature: 0.2
   ---

   # <Name> — <role>
   ...
   ```
2. Add a matching entry under `agent.<name>` in `opencode-agents.template.json`
   (pick a permission set: orchestrator-style deny-everything, reviewer-style
   read-only, or builder-style full access).
3. Run `atelier deploy` to push the new files to `~/.config/opencode/`.
4. Add the agent id to `AGENT_MAPPING` in `server/.env`:
   ```
   AGENT_MAPPING=...,<name>:<name>
   ```
5. (Optional) Override its model in `server/agent-models.json`:
   ```json
   { "models": { "<name>": "<provider>/<long-context-model>" } }
   ```

## What the deploy script does

- **Creates** `~/.config/opencode/agents/<name>.md` only if missing.
- **Merges** the `agent.*` block from `opencode-agents.template.json` into
  the existing `~/.config/opencode/opencode.json` — your `provider`,
  `mcp`, and `plugin` blocks are preserved untouched.
- **Never** touches API keys.