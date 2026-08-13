# deploy.ps1 — Atelier one-click environment deployment
#
# Auto-detects what's installed, installs what's missing, and stages all
# config files. Idempotent — safe to run multiple times.
#
# Usage:
#   .\deploy.ps1                 # full deploy (skip non-essential installs)
#   .\deploy.ps1 -Start          # deploy + launch atelier immediately
#   .\deploy.ps1 -InstallOpencode  # also npm install -g opencode if missing
#   .\deploy.ps1 -ForceAgents    # overwrite ~/.config/opencode/agents/*.md
#   .\deploy.ps1 -SkipPython     # skip Proserpina bridge
#   .\deploy.ps1 -DryRun         # show what would happen, do nothing
#
# Exit codes:
#   0 = success
#   1 = fatal (Node missing, etc.)

[CmdletBinding()]
param(
  [switch]$Start,
  [switch]$InstallOpencode,
  [switch]$ForceAgents,
  [switch]$SkipPython,
  [switch]$DryRun,
  [switch]$ForceConfig,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir

# Force UTF-8 console so Chinese chars / em-dashes render. The Windows
# console defaults to the system OEM codepage (e.g. CP936 on CN locales),
# which silently mangles anything outside its repertoire. Setting both
# .NET stream encoding AND the Win32 console codepage covers all the
# code paths (Write-Host, [Console]::WriteLine, external process stdout).
try {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = $utf8
  [Console]::InputEncoding  = $utf8
  $OutputEncoding = $utf8

  # Win32 SetConsoleOutputCP(65001) — without this, even UTF-8 strings
  # get re-encoded to CP936 on the way to the terminal.
  $setCp = @'
using System;
using System.Runtime.InteropServices;
public class ConsoleCp {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetConsoleOutputCP(uint wCodePageID);
}
'@
  if (-not ([System.Management.Automation.PSTypeName]'ConsoleCp').Type) {
    Add-Type -TypeDefinition $setCp -Language CSharp
  }
  [ConsoleCp]::SetConsoleOutputCP(65001) | Out-Null
} catch {}

# ----- pretty output ---------------------------------------------------------
function Say([string]$Msg, [string]$Color = "") {
  if ($Color -and [Console]::IsOutputRedirected -eq $false) {
    Write-Host $Msg -ForegroundColor $Color
  } else {
    [Console]::WriteLine($Msg)
  }
}
function Ok([string]$Msg)   { Say "  [+] $Msg" "Green" }
function Warn([string]$Msg)  { Say "  [!] $Msg" "Yellow" }
function Fail([string]$Msg)  { Say "  [x] $Msg" "Red" }
function Head([string]$Msg)  { Say "`n=== $Msg ===" "Cyan" }

if ($Help) {
  Get-Help $MyInvocation.MyCommand.Path
  exit 0
}

if ($DryRun) { Say "[dry-run] no changes will be made" "Yellow" }

# ----- 0. pre-flight: detect OS + tooling ------------------------------------

Head "0/7  Pre-flight detection"

$os = if ($IsWindows -or $env:OS -eq "Windows_NT") { "Windows" } else { "Posix" }
Say "  OS: $os"

# Node
$nodeOk = $false
$nodeVer = $null
try {
  $nodeVer = (& node --version 2>$null) -replace '^v', ''
  if ($nodeVer) {
    $major = [int]($nodeVer.Split('.')[0])
    if ($major -ge 22) {
      Ok "Node $nodeVer (>= 22 required)"
      $nodeOk = $true
    } else {
      Fail "Node $nodeVer is too old (need >= 22). Run: https://nodejs.org/"
    }
  }
} catch {}
if (-not $nodeOk) {
  Fail "Node not found. Install Node 22+ from https://nodejs.org/"
  exit 1
}

# npm
try {
  $npmVer = (& npm --version 2>$null).Trim()
  Ok "npm $npmVer"
} catch {
  Fail "npm not found (should ship with Node)"
  exit 1
}

# opencode CLI (optional but required for runtime)
$opencodeOk = $false
$opencodeVer = $null
try {
  $opencodeVer = (& opencode --version 2>$null) | Select-Object -First 1
  if ($opencodeVer) {
    Ok "opencode $opencodeVer"
    $opencodeOk = $true
  }
} catch {}
if (-not $opencodeOk) {
  Warn "opencode CLI not found"
  if ($InstallOpencode -or $ForceConfig) {
    if (-not $DryRun) {
      Say "  -> installing opencode via npm (global)..."
      npm install -g opencode | Out-Null
      try {
        $opencodeVer = (& opencode --version 2>$null) | Select-Object -First 1
        Ok "opencode installed: $opencodeVer"
        $opencodeOk = $true
      } catch {
        Fail "npm install -g opencode failed — try manually: npm install -g opencode"
      }
    } else {
      Say "  -> would run: npm install -g opencode"
    }
  } else {
    Say "  -> runtime will fall back to mock unless you pass -InstallOpencode or run: npm install -g opencode"
  }
}

# Python (optional — only needed for Proserpina review bridge)
$pythonOk = $false
$pythonVer = $null
if (-not $SkipPython) {
  foreach ($cmd in @("python", "python3", "py")) {
    try {
      $v = (& $cmd --version 2>$null)
      if ($v -and $v -match "Python (\d+)\.(\d+)") {
        $maj = [int]$Matches[1]
        $min = [int]$Matches[2]
        if ($maj -ge 3 -and $min -ge 10) {
          $pythonVer = "$maj.$min ($cmd)"
          $pythonOk = $true
          break
        }
      }
    } catch {}
  }
  if ($pythonOk) { Ok "Python $pythonVer" } else { Warn "Python >= 3.10 not found (Proserpina bridge will be skipped)" }
}

# Git (optional)
$gitOk = $false
try { $gitVer = (& git --version 2>$null) | Select-Object -First 1; if ($gitVer) { Ok $gitVer; $gitOk = $true } } catch {}

# ----- 1. config staging ------------------------------------------------------

Head "1/7  Stage config files"

$OpencodeRoot = Join-Path $env:USERPROFILE ".config\opencode"
$OpencodeAgentsDir = Join-Path $OpencodeRoot "agents"
$OpencodeJson = Join-Path $OpencodeRoot "opencode.json"
$ServerEnv = Join-Path $Root "server\.env"
$AgentModelsJson = Join-Path $Root "server\agent-models.json"
$AgentModelsExample = Join-Path $Root "server\agent-models.example.json"
$TemplateDir = Join-Path $Root "opencode-config"
$TemplateAgentsDir = Join-Path $TemplateDir "agents"
$TemplateAgentsJson = Join-Path $TemplateDir "opencode-agents.template.json"

# 1a. ~/.config/opencode/agents/*.md
if (-not $DryRun) {
  if (-not (Test-Path $OpencodeAgentsDir)) {
    New-Item -ItemType Directory -Path $OpencodeAgentsDir -Force | Out-Null
  }
}
$agentFiles = Get-ChildItem -Path $TemplateAgentsDir -Filter "*.md" -ErrorAction SilentlyContinue
if (-not $agentFiles) {
  Warn "no agent templates found at $TemplateAgentsDir"
} else {
  foreach ($f in $agentFiles) {
    $dest = Join-Path $OpencodeAgentsDir $f.Name
    if ((Test-Path $dest) -and -not $ForceAgents) {
      Say "  [=] $($f.Name) - exists (use -ForceAgents to overwrite)"
    } else {
      if (-not $DryRun) { Copy-Item -LiteralPath $f.FullName -Destination $dest -Force }
      Ok "$($f.Name) -> $dest"
    }
  }
}

# 1b. server/.env from .env.example
if (-not $DryRun -and -not (Test-Path $ServerEnv)) {
  $envExample = Join-Path $Root "server\.env.example"
  if (Test-Path $envExample) {
    Copy-Item -LiteralPath $envExample -Destination $ServerEnv -Force
    Ok "server\.env created from .env.example"
  } else {
    Warn ".env.example missing at $envExample — create server\.env manually"
  }
} elseif (Test-Path $ServerEnv) {
  Say "  [=] server\.env exists"
}

# 1c. server/agent-models.json — per-machine config. If missing, create it
#     from the .example template (never overwrite an existing one).
if (Test-Path $AgentModelsJson) {
  Say "  [=] server\agent-models.json exists (preserved)"
} elseif (Test-Path $AgentModelsExample) {
  if (-not $DryRun) {
    Copy-Item -LiteralPath $AgentModelsExample -Destination $AgentModelsJson -Force
  }
  Ok "server\agent-models.json created from agent-models.example.json"
} else {
  Warn "server\agent-models.json missing and no .example template — please create it manually"
}

# 1d. merge opencode-agents.template.json into ~/.config/opencode/opencode.json
if (Test-Path $TemplateAgentsJson) {
  $template = Get-Content -Raw -Path $TemplateAgentsJson -Encoding UTF8 -ErrorAction SilentlyContinue | ConvertFrom-Json
  if (-not $template) {
    Fail "failed to parse $TemplateAgentsJson"
  } elseif (-not $DryRun) {
    $userConfig = $null
    if (Test-Path $OpencodeJson) {
      try { $userConfig = Get-Content -Raw -Path $OpencodeJson -Encoding UTF8 | ConvertFrom-Json } catch {
        Warn "could not parse existing $OpencodeJson - backing up and starting fresh"
        Copy-Item -LiteralPath $OpencodeJson -Destination "$OpencodeJson.bak" -Force
        $userConfig = $null
      }
    }
    if ($null -eq $userConfig) {
      # Write a minimal opencode.json with only the agent block. There is no
      # full example in the repo, so provider/mcp blocks can't be staged here —
      # warn loudly, since a config without them can't reach the LLM.
      Warn "no existing $OpencodeJson — writing agent-only template"
      Say "  [!] opencode.json has NO provider/mcp blocks yet. Copy them from a"
      Say "      working setup, or run 'opencode auth login' first — otherwise"
      Say "      'atelier start' agents can't reach any LLM."
      # Strip non-schema meta fields (anything starting with "_" — e.g.
      # _comment). opencode strictly rejects unknown top-level keys, so any
      # such field baked into a template would crash the CLI on startup.
      $template.PSObject.Properties | Where-Object { $_.Name -like "_*" } | ForEach-Object { $template.PSObject.Properties.Remove($_.Name) }
      $template | ConvertTo-Json -Depth 10 | Set-Content -Path $OpencodeJson -Encoding UTF8
      Ok "$OpencodeJson created"
    } else {
      # Merge agent.* entries — only add missing agents, never overwrite existing
      $merged = 0
      if (-not $userConfig.agent) { $userConfig | Add-Member -NotePropertyName "agent" -NotePropertyValue ([pscustomobject]@{}) }
      foreach ($prop in $template.agent.PSObject.Properties) {
        if ($userConfig.agent.PSObject.Properties.Name -contains $prop.Name) {
          Say "  [=] agent.$($prop.Name) already defined — preserved"
        } else {
          $userConfig.agent | Add-Member -NotePropertyName $prop.Name -NotePropertyValue $prop.Value
          $merged++
          Ok "merged agent.$($prop.Name)"
        }
      }
      if ($merged -gt 0) {
        # Strip non-schema meta fields (anything starting with "_") from the
        # user config before serializing — opencode strictly rejects unknown
        # top-level keys, so any stale "_comment" / "_meta" / etc. would
        # crash the CLI on startup.
        $userConfig.PSObject.Properties | Where-Object { $_.Name -like "_*" } | ForEach-Object { $userConfig.PSObject.Properties.Remove($_.Name) }
        $userConfig | ConvertTo-Json -Depth 20 | Set-Content -Path $OpencodeJson -Encoding UTF8
        Ok "opencode.json updated ($merged new agent(s))"
      } else {
        # No merge needed but still clean stale meta fields defensively.
        $dirty = $userConfig.PSObject.Properties | Where-Object { $_.Name -like "_*" }
        if ($dirty) {
          $dirty | ForEach-Object { $userConfig.PSObject.Properties.Remove($_.Name) }
          $userConfig | ConvertTo-Json -Depth 20 | Set-Content -Path $OpencodeJson -Encoding UTF8
          Say "  [=] stripped $(@($dirty).Count) meta field(s) from existing $OpencodeJson"
        } else {
          Say "  [=] opencode.json unchanged"
        }
      }
    }
  } else {
    Say "  -> would merge $($template.agent.PSObject.Properties.Name -join ',') into opencode.json"
  }
} else {
  Warn "opencode-agents.template.json not found at $TemplateAgentsJson"
}

# ----- 2. create runtime dirs -------------------------------------------------

Head "2/7  Create runtime directories"

$dataDir = Join-Path $Root "server\data"
$logsDir = Join-Path $Root "logs"
foreach ($d in @($dataDir, $logsDir)) {
  if (-not (Test-Path $d)) {
    if (-not $DryRun) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    Ok "created $d"
  } else {
    Say "  [=] $d exists"
  }
}

# ----- 3. install npm deps ----------------------------------------------------

Head "3/7  Install npm dependencies"

function Install-NpmDeps([string]$Label, [string]$Dir) {
  $nm = Join-Path $Dir "node_modules"
  if (Test-Path $nm) {
    $cnt = (Get-ChildItem -LiteralPath $nm -ErrorAction SilentlyContinue | Measure-Object).Count
    Say "  [=] $Label — node_modules exists ($cnt entries)"
    return
  }
  if ($DryRun) { Say "  -> would run: npm install in $Dir"; return }
  Say "  -> running npm install in $Dir ..."
  Push-Location $Dir
  try {
    npm install --no-audit --no-fund --loglevel=error 2>&1 | Tee-Object -Variable npmOut | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed in $Dir"; throw $npmOut }
    Ok "$Label — npm install ok"
  } finally { Pop-Location }
}

Install-NpmDeps "frontend (root)" $Root
Install-NpmDeps "server" (Join-Path $Root "server")

# ----- 4. install python deps (optional) --------------------------------------

Head "4/7  Install Proserpina bridge (Python)"

$bridgeDir = Join-Path $Root "proserpina-bridge"
if ($SkipPython) {
  Say "  -> skipped (--SkipPython)"
} elseif (-not (Test-Path $bridgeDir)) {
  Warn "proserpina-bridge dir not found — skipping"
} elseif (-not $pythonOk) {
  Warn "Python not available — skipping (review bridge will be offline)"
} else {
  $venv = Join-Path $bridgeDir ".venv"
  if (Test-Path $venv) {
    Say "  [=] .venv exists"
  } else {
    if ($DryRun) { Say "  -> would create venv + pip install"; return }
    Say "  -> creating venv and installing requirements ..."
    Push-Location $bridgeDir
    try {
      python -m venv .venv 2>&1 | Out-Null
      # pip's exit code is non-zero on warnings (e.g. cache deserialization),
      # so we only treat hard process failures as fatal.
      $py = ".\.venv\Scripts\python.exe"
      & $py -m pip install --upgrade pip --disable-pip-version-check 2>&1 | Out-Null
      & $py -m pip install -r requirements.txt --disable-pip-version-check 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 1) { Ok ".venv ready" }
      else { Warn "pip install failed (exit $LASTEXITCODE) — review bridge may be offline" }
    } finally { Pop-Location }
  }
}

# ----- 5. PATH setup ----------------------------------------------------------

Head "5/7  Add scripts\ to user PATH"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$ScriptDir*") {
  if (-not $DryRun) {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$ScriptDir", "User")
    Ok "added $ScriptDir to user PATH (new terminals will see 'atelier' / 'deploy.ps1')"
  } else {
    Say "  -> would add $ScriptDir to user PATH"
  }
} else {
  Say "  [=] $ScriptDir already on user PATH"
}
# Also patch the current session
if (($env:Path -split ';') -notcontains $ScriptDir) {
  $env:Path = "$env:Path;$ScriptDir"
}

# ----- 6. verify --------------------------------------------------------------

Head "6/7  Verify"

$failures = 0

# Server typecheck
if (-not $DryRun) {
  Push-Location (Join-Path $Root "server")
  try {
    # On Windows npm.cmd is the batch shim; calling npm directly via
    # PowerShell's & operator sometimes drops the first arg (`pm`). Use
    # `cmd /c` to keep the args intact.
    $tcOut = & cmd.exe /d /s /c "npm.cmd run --silent typecheck" 2>&1
    if ($LASTEXITCODE -eq 0) { Ok "server typecheck ok" }
    else { Warn "server typecheck reported issues (non-fatal - server will still run):"; $tcOut | Select-Object -Last 8 | ForEach-Object { Say "      $_" } }
  } catch {
    Warn "typecheck failed to run: $_"
  } finally { Pop-Location }
}

# Free ports
$ports = @(8787, 5173, 8765)
foreach ($p in $ports) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect("127.0.0.1", $p, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(60, $false)) {
      Warn "port $p already in use — close it before starting atelier"
      $failures++
    } else {
      Ok "port $p free"
    }
  } catch {
    Ok "port $p free"
  } finally { try { $c.Close() } catch {} }
}

# ----- 7. summary -------------------------------------------------------------

Head "7/7  Summary"

$ocStatus = if ($opencodeOk) { "ready ($opencodeVer)" } else { "MISSING" }
$pyStatus = if ($pythonOk) { $pythonVer } else { "skipped / missing" }
$envStatus = if (Test-Path $ServerEnv) { "ready" } else { "MISSING" }
$modelsStatus = if (Test-Path $AgentModelsJson) { "ready" } else { "MISSING" }

$lines = @(
  "+-------------------------------------------+"
  "|  Atelier deployment finished              |"
  "|                                           |"
  "|  Root:        $Root"
  "|  opencode:    $ocStatus"
  "|  python:      $pyStatus"
  "|  server env:  $envStatus"
  "|  models:      $modelsStatus"
  "|  agents dir:  $OpencodeAgentsDir"
  "|                                           |"
  "|  Next:  atelier start                     |"
  "|  Edit:  $AgentModelsJson"
  "|  Logs:  $Root\logs                        |"
  "+-------------------------------------------+"
)
foreach ($line in $lines) { Say $line "Cyan" }

if ($failures -gt 0) {
  Warn "$failures port(s) in use — atelier start may fail"
}

if (-not $DryRun) {
  Say "`n[deploy] done — run 'atelier start' (or 'atelier -Help' for subcommands).`n"
}

if ($Start -and -not $DryRun) {
  Say "[deploy] launching atelier ..."
  & (Join-Path $ScriptDir "atelier.ps1") start
}