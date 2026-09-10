import { tool } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"

// capture_screen — give Vis (and other vision-capable agents) the ability
// to capture the screen or a specific window and see the result.
//
// Two modes:
//   url    — capture a web page with playwright-cli (headless msedge).
//            Best for localhost dev servers (e.g. a page Forge just built).
//   window — capture the full screen or a named window via PowerShell + .NET
//            BitBlt. Covers exe / games / any desktop window.
//
// Screenshots land in D:\AndroidData\.playwright-cli\screenshots (inside
// playwright-cli's allowed roots), then the PNG is returned to the model as
// a data-URL image attachment so the vision model sees it directly.
//
// IMPORTANT: the model is the caller — it must invoke this tool with the
// target it wants captured, then describe/analyze what it sees in the image.

const SHOT_DIR = resolve("D:/AndroidData/.playwright-cli/screenshots")

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
}

function pngToDataUrl(filePath: string): string {
  const buf = readFileSync(filePath)
  return `data:image/png;base64,${buf.toString("base64")}`
}

function captureWindow(target: string): string {
  // Escaped for embedding in the PowerShell script string below.
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$target = '${target.replace(/'/g, "''")}'
$out = '${SHOT_DIR}'
if (!(Test-Path $out)) { New-Item -ItemType Directory -Path $out | Out-Null }

if ($target -eq '') {
  # Full screen
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
} else {
  # Capture a specific window by title substring (front-most match).
  $proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$target*" } | Select-Object -First 1
  if (-not $proc) { throw "No window with title containing: $target" }
  Add-Type -MemberDefinition @'
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@ -Name Win32 -Namespace Native
  $rect = New-Object Native.Win32+RECT
  [Native.Win32]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
  [Native.Win32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 200
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
}

$file = Join-Path $out ('capture_' + [Guid]::NewGuid().ToString('N') + '.png')
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output $file
`
  const ps = join(tmpdir(), `capture_${randomUUID()}.ps1`)
  writeFileSync(ps, psScript, "utf8")
  try {
    const out = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps])
    return out.trim().split(/\r?\n/).pop() ?? ""
  } finally {
    try { rmSync(ps, { force: true }) } catch {}
  }
}

function captureUrl(url: string): string {
  const out = join(SHOT_DIR, `web_${randomUUID()}.png`)
  // playwright-cli only accepts files under its allowed roots — SHOT_DIR
  // (D:\AndroidData\.playwright-cli\screenshots) is inside those roots, so
  // an absolute --filename is accepted.
  run("playwright-cli", ["open", "--browser=msedge"])
  try {
    run("playwright-cli", ["goto", url])
    run("playwright-cli", ["screenshot", `--filename=${out}`])
  } finally {
    try { run("playwright-cli", ["close"]) } catch {}
  }
  if (!existsSync(out)) throw new Error(`screenshot not produced for url: ${url}`)
  return out
}

export default tool({
  description: `Capture a screenshot and return it as an image the model can see.
Two modes:
  - url: capture a web page. Pass "url" like http://127.0.0.1:5173/ or https://example.com. Uses headless browser.
  - window: capture the full screen or a desktop window (exe / game / any app). Pass "window" (empty or a title substring) to capture the screen or the first window whose title contains it.
The tool returns the PNG as an image attachment plus the file path. Use it when you need to SEE the current UI, a web page, or an app window before analyzing it visually.`,
  args: {
    mode: tool.schema.enum(["url", "window"]).describe("url = capture a web page; window = capture screen/desktop window"),
    target: tool.schema.string().describe("For url mode: the page URL. For window mode: window title substring, or empty string for full screen"),
  },
  async execute(args) {
    const mode = args.mode
    const target = (args.target ?? "").trim()
    let filePath: string

    if (mode === "url") {
      filePath = captureUrl(target)
    } else {
      filePath = captureWindow(target)
    }

    if (!existsSync(filePath)) throw new Error(`capture failed: ${filePath}`)

    return {
      output: `Captured screenshot saved to ${filePath}. You can now see the image above — analyze it.`,
      attachments: [{
        type: "file",
        mime: "image/png",
        url: pngToDataUrl(filePath),
        filename: filePath.split(/[\\/]/).pop() ?? "capture.png",
      }],
    }
  },
})
