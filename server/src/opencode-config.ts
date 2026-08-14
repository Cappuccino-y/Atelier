/**
 * opencode-config.ts — auto-sync Atelier's bundled agent definitions into
 * the user's `~/.config/opencode/opencode.json` on every server start.
 *
 * Problem this solves: Atelier ships 9 agents (atlas/forge/lens/echo/
 * trainer/scout/analyst/writer/archivist) but the opencode CLI that
 * spawns the actual agent processes reads ITS OWN config at
 * `~/.config/opencode/opencode.json`. If the user hasn't run `atelier
 * deploy`, the specialist agents (scout/analyst/writer/archivist) are
 * missing there, and `opencode run --agent writer` fails with
 * `agent "writer" not found. Falling back to default agent`.
 *
 * This module runs `ensureOpencodeAgents()` at server startup and
 * idempotently merges any missing `agent.*` entries from
 * `opencode-config/opencode-agents.template.json` into the user's
 * config, WITHOUT touching provider / mcp / plugin blocks.
 *
 * Safety:
 *   - Existing agent entries are never overwritten (only added when missing)
 *   - provider/mcp/plugin blocks are preserved untouched
 *   - If the user's opencode.json is missing or invalid JSON, we back it
 *     up to .bak and skip (never clobber a config we can't parse)
 *   - Every mutation is atomic (write temp + rename)
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OPENCODE_ROOT = join(homedir(), ".config", "opencode");
const OPENCODE_JSON = join(OPENCODE_ROOT, "opencode.json");
const OPENCODE_AGENTS_DIR = join(OPENCODE_ROOT, "agents");
const TEMPLATE_JSON = join(__dirname, "..", "..", "opencode-config", "opencode-agents.template.json");
const TEMPLATE_AGENTS_DIR = join(__dirname, "..", "..", "opencode-config", "agents");

export type OpenCodeSyncResult = {
  merged: string[];        // agent ids newly added to opencode.json
  copied: string[];        // prompt .md files copied into ~/.config/opencode/agents/
  skipped: boolean;        // true when we couldn't safely patch (config missing/invalid)
  skipReason?: string;
};

type AgentValue = Record<string, unknown>;

/** Deep-clone a JSON-parsed value so we never mutate template by reference. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Idempotently ensure the opencode CLI knows about all Atelier agents.
 * Call once at server startup; safe to call repeatedly.
 */
export function ensureOpencodeAgents(): OpenCodeSyncResult {
  const result: OpenCodeSyncResult = { merged: [], copied: [], skipped: false };

  // 1. Copy missing prompt .md files into ~/.config/opencode/agents/.
  if (existsSync(TEMPLATE_AGENTS_DIR)) {
    mkdirSync(OPENCODE_AGENTS_DIR, { recursive: true });
    for (const name of readdirSafe(TEMPLATE_AGENTS_DIR)) {
      if (!name.endsWith(".md")) continue;
      const src = join(TEMPLATE_AGENTS_DIR, name);
      const dst = join(OPENCODE_AGENTS_DIR, name);
      if (!existsSync(dst)) {
        try {
          copyFileSync(src, dst);
          result.copied.push(name);
        } catch (err) {
          console.warn(`[opencode-config] failed to copy ${name}:`, err);
        }
      }
    }
  }

  // 2. Read the user's opencode.json. If missing → skip (deploy handles
  //    fresh installs). If invalid JSON → back up + skip.
  if (!existsSync(OPENCODE_JSON)) {
    result.skipped = true;
    result.skipReason = `opencode.json not found at ${OPENCODE_JSON} — run 'atelier deploy' for fresh installs`;
    return result;
  }
  let userConfig: Record<string, unknown>;
  try {
    // Strip UTF-8 BOM — PowerShell/editor saves often add one, and JSON.parse
    // rejects it, which previously mis-diagnosed a perfectly good file as
    // "invalid JSON" (backed up + skipped → agents never synced).
    let raw = readFileSync(OPENCODE_JSON, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    userConfig = JSON.parse(raw);
  } catch (err) {
    const bak = `${OPENCODE_JSON}.bak`;
    try { copyFileSync(OPENCODE_JSON, bak); } catch { /* ignore */ }
    result.skipped = true;
    result.skipReason = `opencode.json is invalid JSON (backed up to ${bak}) — run 'atelier deploy -ForceConfig' to repair`;
    return result;
  }

  // 3. Read the bundled template. Strip any non-schema meta fields
  //    (anything starting with "_") — opencode strictly rejects unknown
  //    top-level keys, so a stray "_comment" / "_meta" in the template
  //    would crash the CLI on startup.
  let template: { agent?: Record<string, AgentValue> };
  try {
    const raw = JSON.parse(readFileSync(TEMPLATE_JSON, "utf8"));
    for (const k of Object.keys(raw)) {
      if (k.startsWith("_")) delete (raw as Record<string, unknown>)[k];
    }
    template = raw;
  } catch (err) {
    result.skipped = true;
    result.skipReason = `template ${TEMPLATE_JSON} is invalid or missing`;
    return result;
  }
  const templateAgents = template.agent ?? {};
  const templateIds = Object.keys(templateAgents);
  if (templateIds.length === 0) {
    result.skipped = true;
    result.skipReason = "template has no agent.* entries";
    return result;
  }

  // 4. Merge missing agent.* entries (never overwrite existing).
  const userAgent = (userConfig.agent ?? {}) as Record<string, unknown>;
  const known = new Set(Object.keys(userAgent));
  let changed = false;
  for (const id of templateIds) {
    if (known.has(id)) continue;
    userAgent[id] = clone(templateAgents[id]);
    result.merged.push(id);
    changed = true;
  }

  if (changed) {
    userConfig.agent = userAgent;
    // Atomic write: temp + rename on same volume.
    const tmp = `${OPENCODE_JSON}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(userConfig, null, 2) + "\n", "utf8");
      renameSync(tmp, OPENCODE_JSON);
    } catch (err) {
      console.error(`[opencode-config] failed to write ${OPENCODE_JSON}:`, err);
      result.skipped = true;
      result.skipReason = `write failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return result;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
