# atelier.ps1 - master controller
# Usage:
#   atelier            -> start (default)
#   atelier start      -> kill old port procs + start all + open browser
#   atelier stop       -> kill processes on atelier ports
#   atelier restart    -> stop + start
#   atelier status     -> show port bindings
#   atelier logs <n>   -> tail logs (server|frontend|proserpina)

[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$LogsDir = Join-Path $Root "logs"
if (!(Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir | Out-Null }
Set-Location $Root

# Add scripts dir to user PATH (persists for new terminals)
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$ScriptDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$ScriptDir", "User")
}
if (($env:Path -split ';') -notcontains $ScriptDir) {
  $env:Path = "$env:Path;$ScriptDir"
}

function Say([string]$Msg, [string]$Color = "") {
  if ($Color -and [Console]::IsOutputRedirected -eq $false) {
    Write-Host $Msg -ForegroundColor $Color
  } else {
    [Console]::WriteLine($Msg)
  }
}

$Ports = @{ server = 8787; frontend = 5173; bridge = 8765 }

# Fast TCP probe - tells us if port is listening.
# When port is open, returns in ~1ms. When closed, OS sends RST in <5ms
# locally, but the .NET socket may need up to ~30ms to surface the failure.
function Test-PortListening([int]$Port, [int]$TimeoutMs = 80) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
    if ($ok) {
      try { $client.EndConnect($iar) } catch {}
      return $true
    }
    return $false
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch {}
  }
}

# Get PIDs bound to multiple ports in one pass. netstat -ano is ~40ms
# regardless of port count vs Get-NetTCPConnection which can take 1s+ per CIM
# query. We do one netstat and filter for all our ports.
function Get-AllAtelierPids {
  $seen = @{}
  $output = & netstat.exe -ano -p TCP 2>$null
  foreach ($line in $output) {
    foreach ($port in $Ports.Values) {
      if ($line -match ":$port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
        $p = [int]$Matches[1]
        if ($p -gt 0 -and $p -ne $PID) { $seen[$p] = $true }
      }
    }
  }
  return @($seen.Keys | Sort-Object)
}

function Stop-AtelierPorts {
  $pids = Get-AllAtelierPids
  if ($pids.Count -eq 0) { return 0 }

  # Fire all taskkills in parallel. Sequential ~200ms/PID, parallel ~200ms
  # total. Use Start-Process (no stdout redirect -> no pipe-buffer deadlock)
  # with per-process timeout as a safety net.
  $procs = @()
  foreach ($p in $pids) {
    $procs += Start-Process -FilePath "taskkill.exe" `
      -ArgumentList "/F","/T","/PID","$p" `
      -WindowStyle Hidden -PassThru
  }
  foreach ($proc in $procs) {
    if (!$proc.WaitForExit(3000)) {
      try { $proc.Kill() } catch {}
    }
  }
  return $pids.Count
}

function Start-Svc([string]$Name, [string]$Cwd, [string]$Cmd, [string[]]$CmdArgs) {
  $logPath = Join-Path $LogsDir "$Name.log"
  $argStr = $Cmd + " " + ($CmdArgs -join ' ')
  $fullCmd = "$argStr > `"$logPath`" 2>&1"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "cmd.exe"
  $psi.Arguments = "/d /s /c `"$fullCmd`""
  $psi.WorkingDirectory = $Cwd
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = "Hidden"
  [void][System.Diagnostics.Process]::Start($psi)
}

function Start-Atelier {
  Say "[atelier] starting..."

  $t0 = [System.Diagnostics.Stopwatch]::StartNew()
  $killed = Stop-AtelierPorts
  if ($killed -gt 0) {
    Say "[atelier] killed $killed old process(es) on ports $($Ports.Values -join ',')" "Yellow"
  }

  # Wait until each port is actually free (or 5s budget). Without this,
  # the next tsx watch hits EADDRINUSE and dies because the OS hasn't
  # recycled the lingering TIME_WAIT/CLOSE_WAIT socket yet.
  if ($killed -gt 0) {
    $released = $false
    for ($w = 0; $w -lt 50; $w++) {
      $stillBound = $false
      $out = & netstat.exe -ano -p TCP 2>$null
      foreach ($port in $Ports.Values) {
        foreach ($line in $out) {
          if ($line -match ":$port\s+\S+\s+LISTENING\s+\d+") {
            $stillBound = $true
            break
          }
        }
        if ($stillBound) { break }
      }
      if (-not $stillBound) { $released = $true; break }
      Start-Sleep -Milliseconds 100
    }
    if (-not $released) {
      Say "[atelier] warning: ports still bound after 5s, proceeding anyway" "Yellow"
    }
  }

  $bridgeDir = Join-Path $Root "proserpina-bridge"
  if (Test-Path $bridgeDir) {
    Start-Svc "proserpina" $bridgeDir "python.exe" @("main.py")
  }
  Start-Svc "server" (Join-Path $Root "server") "npm.cmd" @("run", "dev")
  Start-Svc "frontend" $Root "npm.cmd" @("run", "dev")

  # Poll server readiness via TCP probe. Probe timeout IS the polling
  # interval — no extra sleep needed (would double the wait).
  $ready = $false
  for ($i = 0; $i -lt 100; $i++) {
    if (Test-PortListening 8787 80) { $ready = $true; break }
  }

  Start-Process "http://127.0.0.1:5173" | Out-Null

  $elapsed = $t0.ElapsedMilliseconds
  if ($ready) {
    Say "[atelier] up in ${elapsed}ms - http://127.0.0.1:5173 (logs: $LogsDir)" "Green"
  } else {
    Say "[atelier] launching (server not ready in ${elapsed}ms) - http://127.0.0.1:5173" "Yellow"
  }
  Say "[atelier] cmds: atelier stop | status | logs <server|frontend|proserpina>" "DarkGray"
}

function Show-Status {
  $pids = Get-AllAtelierPids
  foreach ($name in @("server","frontend","bridge")) {
    $port = $Ports[$name]
    if (Test-PortListening $port 200) {
      Say ("[atelier] {0,-10} port {1}  running" -f $name, $port)
    } else {
      Say ("[atelier] {0,-10} port {1}  stopped" -f $name, $port)
    }
  }
}

function Show-Logs([string]$Name) {
  $file = Join-Path $LogsDir "$Name.log"
  if (Test-Path $file) {
    Get-Content $file -Tail 80 -Wait
  } else {
    Say "log not found: $file" "Red"
  }
}

$cmd = if ($Args.Count -gt 0) { $Args[0].ToLower() } else { "start" }
switch ($cmd) {
  "start"   { Start-Atelier }
  "stop"    { $n = Stop-AtelierPorts; Say "[atelier] stopped $n process(es)" }
  "restart" { Stop-AtelierPorts; Start-Atelier }
  "status"  { Show-Status }
  "logs"    { if ($Args.Count -lt 2) { Say "usage: atelier logs <server|frontend|proserpina>" "Yellow" } else { Show-Logs $Args[1] } }
  default   { Say "usage: atelier [start|stop|restart|status|logs <name>]" "Yellow" }
}