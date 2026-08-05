#!/usr/bin/env bash
# deploy.sh — Atelier one-click environment deployment (POSIX)
#
# Mirrors scripts/deploy.ps1 for macOS / Linux.
# Usage:
#   ./deploy.sh                  # full deploy
#   ./deploy.sh --start          # deploy + launch atelier
#   ./deploy.sh --install-opencode
#   ./deploy.sh --force-agents
#   ./deploy.sh --skip-python
#   ./deploy.sh --dry-run
#
# Requires: bash, coreutils, node, npm, (optional) python3, jq.

set -uo pipefail

# ----- locate script + project root ------------------------------------------
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
ROOT="$( cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd )"

# ----- args -------------------------------------------------------------------
START=0
INSTALL_OPENCODE=0
FORCE_AGENTS=0
SKIP_PYTHON=0
DRY_RUN=0
FORCE_CONFIG=0
HELP=0
for arg in "$@"; do
  case "$arg" in
    --start)              START=1 ;;
    --install-opencode)   INSTALL_OPENCODE=1 ;;
    --force-agents)       FORCE_AGENTS=1 ;;
    --skip-python)        SKIP_PYTHON=1 ;;
    --dry-run)            DRY_RUN=1 ;;
    --force-config)       FORCE_CONFIG=1 ;;
    --help|-h)            HELP=1 ;;
    *) echo "[deploy] unknown arg: $arg" >&2 ;;
  esac
done
if [[ "$HELP" -eq 1 ]]; then
  sed -n '3,20p' "$0"
  exit 0
fi

# ----- pretty output ----------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
fi
say()    { printf "%s\n" "$1"; }
ok()     { say "  ${C_GREEN}[+]${C_RESET} $1"; }
warn()   { say "  ${C_YELLOW}[!]${C_RESET} $1"; }
fail()   { say "  ${C_RED}[x]${C_RESET} $1"; }
head()   { say ""; say "${C_CYAN}=== $1 ===${C_RESET}"; }
eq()     { say "  [=] $1"; }

if [[ "$DRY_RUN" -eq 1 ]]; then say "${C_YELLOW}[dry-run]${C_RESET} no changes will be made"; fi

# ----- 0. pre-flight ----------------------------------------------------------

head "0/7  Pre-flight detection"
os=$(uname -s 2>/dev/null || echo Unknown)
say "  OS: $os"

# Node
if ! command -v node >/dev/null 2>&1; then
  fail "Node not found. Install Node 22+ from https://nodejs.org/"
  exit 1
fi
node_ver=$(node --version 2>/dev/null | tr -d 'v')
node_major="${node_ver%%.*}"
if [[ "$node_major" -ge 22 ]]; then
  ok "Node $node_ver (>= 22 required)"
else
  fail "Node $node_ver too old (need >= 22)"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found"
  exit 1
fi
ok "npm $(npm --version 2>/dev/null)"

# opencode
opencode_ok=0
if command -v opencode >/dev/null 2>&1; then
  opencode_ver=$(opencode --version 2>/dev/null | head -n1)
  ok "opencode $opencode_ver"
  opencode_ok=1
else
  warn "opencode CLI not found"
  if [[ "$INSTALL_OPENCODE" -eq 1 || "$FORCE_CONFIG" -eq 1 ]]; then
    if [[ "$DRY_RUN" -eq 0 ]]; then
      say "  -> installing opencode via npm (global)..."
      npm install -g opencode >/dev/null 2>&1 && {
        opencode_ver=$(opencode --version 2>/dev/null | head -n1)
        ok "opencode installed: $opencode_ver"
        opencode_ok=1
      } || fail "npm install -g opencode failed — try manually"
    else
      say "  -> would run: npm install -g opencode"
    fi
  else
    say "  -> runtime will fall back to mock unless you pass --install-opencode"
  fi
fi

# Python
python_ok=0
python_ver=""
if [[ "$SKIP_PYTHON" -eq 0 ]]; then
  for cmd in python3 python py; do
    if command -v "$cmd" >/dev/null 2>&1; then
      v=$("$cmd" --version 2>&1 | head -n1)
      if [[ "$v" =~ Python[[:space:]]([0-9]+)\.([0-9]+) ]]; then
        if [[ "${BASH_REMATCH[1]}" -ge 3 && "${BASH_REMATCH[2]}" -ge 10 ]]; then
          python_ver="$v ($cmd)"
          python_ok=1
          break
        fi
      fi
    fi
  done
  if [[ "$python_ok" -eq 1 ]]; then ok "Python $python_ver"; else warn "Python >= 3.10 not found (review bridge skipped)"; fi
fi

# git
if command -v git >/dev/null 2>&1; then ok "$(git --version)"; fi

# ----- 1. stage configs -------------------------------------------------------

head "1/7  Stage config files"

# Resolve user config root (XDG-aware)
if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
  OPENCODE_ROOT="$XDG_CONFIG_HOME/opencode"
else
  OPENCODE_ROOT="$HOME/.config/opencode"
fi
OPENCODE_AGENTS_DIR="$OPENCODE_ROOT/agents"
OPENCODE_JSON="$OPENCODE_ROOT/opencode.json"
SERVER_ENV="$ROOT/server/.env"
AGENT_MODELS_JSON="$ROOT/server/agent-models.json"
TEMPLATE_DIR="$ROOT/opencode-config"
TEMPLATE_AGENTS_DIR="$TEMPLATE_DIR/agents"
TEMPLATE_AGENTS_JSON="$TEMPLATE_DIR/opencode-agents.template.json"

if [[ "$DRY_RUN" -eq 0 ]]; then mkdir -p "$OPENCODE_AGENTS_DIR"; fi

if [[ -d "$TEMPLATE_AGENTS_DIR" ]]; then
  for f in "$TEMPLATE_AGENTS_DIR"/*.md; do
    [[ -f "$f" ]] || continue
    base=$(basename "$f")
    dest="$OPENCODE_AGENTS_DIR/$base"
    if [[ -f "$dest" && "$FORCE_AGENTS" -eq 0 ]]; then
      eq "$base — exists"
    else
      if [[ "$DRY_RUN" -eq 0 ]]; then cp "$f" "$dest"; fi
      ok "$base -> $dest"
    fi
  done
else
  warn "no agent templates at $TEMPLATE_AGENTS_DIR"
fi

if [[ ! -f "$SERVER_ENV" ]]; then
  if [[ -f "$ROOT/server/.env.example" && "$DRY_RUN" -eq 0 ]]; then
    cp "$ROOT/server/.env.example" "$SERVER_ENV"
    ok "server/.env created from .env.example"
  else
    warn "server/.env not present and .env.example missing — create manually"
  fi
else
  eq "server/.env exists"
fi

if [[ -f "$AGENT_MODELS_JSON" ]]; then
  ok "server/agent-models.json exists"
else
  warn "server/agent-models.json missing"
fi

# 1d. merge opencode-agents.template.json into opencode.json
if [[ -f "$TEMPLATE_AGENTS_JSON" ]]; then
  if ! command -v jq >/dev/null 2>&1; then
    warn "jq not installed — skipping opencode.json merge (install jq or merge manually)"
  elif [[ "$DRY_RUN" -eq 1 ]]; then
    say "  -> would merge template agent.* entries into $OPENCODE_JSON"
  else
    if [[ ! -f "$OPENCODE_JSON" ]]; then
      warn "no existing $OPENCODE_JSON — writing agent.* block only (provider/mcp NOT included)"
      jq '. + {agent: .agent}' "$TEMPLATE_AGENTS_JSON" > "$OPENCODE_JSON"
      ok "$OPENCODE_JSON created"
    else
      # add any agent.* keys missing in user config
      template_agents=$(jq -r '.agent | keys[]' "$TEMPLATE_AGENTS_JSON")
      user_agents=$(jq -r '.agent // {} | keys[]' "$OPENCODE_JSON" 2>/dev/null || true)
      merged=0
      for a in $template_agents; do
        if grep -qx "$a" <<<"$user_agents"; then
          eq "agent.$a already defined — preserved"
        else
          tmp=$(mktemp)
          jq --arg k "$a" --slurpfile v "$TEMPLATE_AGENTS_JSON" '.agent[$k] = $v[0].agent[$k]' "$OPENCODE_JSON" > "$tmp"
          mv "$tmp" "$OPENCODE_JSON"
          merged=$((merged+1))
          ok "merged agent.$a"
        fi
      done
      if [[ "$merged" -gt 0 ]]; then
        ok "opencode.json updated ($merged new agent(s))"
      else
        eq "opencode.json unchanged"
      fi
    fi
  fi
else
  warn "opencode-agents.template.json not found"
fi

# ----- 2. dirs -----------------------------------------------------------------

head "2/7  Create runtime directories"
for d in "$ROOT/server/data" "$ROOT/logs"; do
  if [[ -d "$d" ]]; then eq "$d exists"; else [[ "$DRY_RUN" -eq 0 ]] && mkdir -p "$d"; ok "created $d"; fi
done

# ----- 3. npm deps ------------------------------------------------------------

head "3/7  Install npm dependencies"
install_npm() {
  local label="$1"; local dir="$2"
  if [[ -d "$dir/node_modules" ]]; then
    eq "$label — node_modules exists"
    return
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then say "  -> would run: npm install in $dir"; return
  fi
  say "  -> running npm install in $dir ..."
  (cd "$dir" && npm install --no-audit --no-fund --loglevel=error) || fail "npm install failed in $dir"
}
install_npm "frontend (root)" "$ROOT"
install_npm "server" "$ROOT/server"

# ----- 4. python --------------------------------------------------------------

head "4/7  Install Proserpina bridge (Python)"
BRIDGE_DIR="$ROOT/proserpina-bridge"
if [[ "$SKIP_PYTHON" -eq 1 ]]; then
  eq "skipped (--skip-python)"
elif [[ ! -d "$BRIDGE_DIR" ]]; then
  warn "proserpina-bridge dir not found"
elif [[ "$python_ok" -eq 0 ]]; then
  warn "Python not available — skipping"
elif [[ -d "$BRIDGE_DIR/.venv" ]]; then
  eq ".venv exists"
else
  if [[ "$DRY_RUN" -eq 1 ]]; then say "  -> would create venv + pip install"; continue; fi
  say "  -> creating venv and installing requirements ..."
  (cd "$BRIDGE_DIR" && python3 -m venv .venv && \
    .venv/bin/python -m pip install --upgrade pip --quiet && \
    .venv/bin/python -m pip install -r requirements.txt --quiet) \
    && ok ".venv ready" || warn "pip install failed — review bridge may be offline"
fi

# ----- 5. PATH ----------------------------------------------------------------

head "5/7  Add scripts/ to user PATH"
shell_rc=""
case "${SHELL:-/bin/bash}" in
  *zsh)  shell_rc="$HOME/.zshrc" ;;
  *bash) shell_rc="$HOME/.bashrc" ;;
  *)     shell_rc="$HOME/.profile" ;;
esac
if [[ -n "$shell_rc" && -f "$shell_rc" ]] && grep -q "$SCRIPT_DIR" "$shell_rc"; then
  eq "$SCRIPT_DIR already on PATH ($shell_rc)"
else
  if [[ "$DRY_RUN" -eq 0 && -n "$shell_rc" ]]; then
    {
      echo ""
      echo "# Atelier scripts (added by deploy.sh)"
      echo "export PATH=\"$SCRIPT_DIR:\$PATH\""
    } >> "$shell_rc"
    ok "appended PATH export to $shell_rc"
  else
    say "  -> would append PATH export to $shell_rc"
  fi
fi

# ----- 6. verify --------------------------------------------------------------

head "6/7  Verify"
failures=0
for p in 8787 5173 8765; do
  if (echo > "/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    warn "port $p already in use"
    failures=$((failures+1))
  else
    ok "port $p free"
  fi
done

if [[ "$DRY_RUN" -eq 0 ]]; then
  (cd "$ROOT/server" && npm run --silent typecheck 2>&1) \
    && ok "server typecheck ok" \
    || warn "server typecheck reported issues (non-fatal)"
fi

# ----- 7. summary -------------------------------------------------------------

head "7/7  Summary"
cat <<EOF
${C_CYAN}
  ┌──────────────────────────────────────────┐
  │   Atelier deployment finished            │
  │                                          │
  │   Root:        $ROOT
  │   opencode:    $([[ $opencode_ok -eq 1 ]] && echo "ready ($opencode_ver)" || echo "MISSING")
  │   python:      $([[ $python_ok -eq 1 ]] && echo "$python_ver" || echo "skipped / missing")
  │   server env:  $([[ -f $SERVER_ENV ]] && echo "ready" || echo "MISSING")
  │   models:      $([[ -f $AGENT_MODELS_JSON ]] && echo "ready" || echo "MISSING")
  │   agents dir:  $OPENCODE_AGENTS_DIR
  │                                          │
  │   Next:  atelier start                   │
  │   Edit:  $AGENT_MODELS_JSON
  │   Logs:  $ROOT/logs                      │
  └──────────────────────────────────────────┘
${C_RESET}
EOF

if [[ "$failures" -gt 0 ]]; then warn "$failures port(s) in use"; fi

if [[ "$START" -eq 1 && "$DRY_RUN" -eq 0 ]]; then
  say "[deploy] launching atelier ..."
  "$SCRIPT_DIR/atelier.sh" start || say "[deploy] atelier.sh not found — start manually"
fi