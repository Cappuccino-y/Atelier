import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";

export type AgentRunOptions = {
  agentName: string;
  opencodeAgent: string;
  model?: string;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
};

export type AgentRunResult = {
  content: string;
  success: boolean;
  error?: string;
  rawEvents?: unknown[];
};

const MOCK_RESPONSES: Record<string, string> = {
  atlas: "[DECISION] 收到。让 Forge 去实现，@Forge 实现这个需求。\n\n[RESULT] 已分派给 Forge。",
  forge: "[RESULT] 实现完成（mock）。变更：新增 2 个文件，修改 1 个函数。\n\n@Lens 请 review。",
  lens: "[REVIEW]\n- **minor**: 命名一致性\n  - location: src/foo.ts:42\n  - quote: const a = 1\n  - suggested: 改为 const count = 1\n\n@Atlas 收尾。",
  echo: "[QUESTION] 这个问题需要更多信息。\n\n@Atlas 帮我确认下细节。",
};

export async function runOpenCodeAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  if (config.agentRuntime === "mock") return mockResponse(opts);
  return runRealAgent(opts);
}

function mockResponse(opts: AgentRunOptions): AgentRunResult {
  const key = opts.agentName.toLowerCase();
  return {
    content: MOCK_RESPONSES[key] ?? "[RESULT] 完成（mock）。",
    success: true,
  };
}

function runRealAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  return new Promise((resolve) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "atelier-"));
    const promptFile = join(tmpDir, "prompt.txt");
    const batFile = join(tmpDir, "run.bat");
    writeFileSync(promptFile, opts.prompt, "utf8");

    const model = opts.model ?? config.opencodeModel;
    const cwd = opts.cwd ?? process.cwd();
    const timeoutMs = opts.timeoutMs ?? config.opencodeTimeout;

    const batContent = `@echo off
chcp 65001 >nul
type "${promptFile}" | opencode run - --agent "${opts.opencodeAgent}" --model "${model}" --dir "${cwd}" --format json
`;
    writeFileSync(batFile, batContent, "utf8");

    let stdout = "";
    let stderr = "";
    let killed = false;

    const child = spawn("cmd.exe", ["/d", "/s", "/c", batFile], {
      windowsHide: true,
      cwd,
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}

      if (killed) {
        resolve({ content: "", success: false, error: `timeout after ${timeoutMs}ms` });
        return;
      }

      const parsed = parseOpenCodeOutput(stdout);
      if (parsed.success) {
        resolve(parsed);
      } else {
        resolve({
          content: parsed.content || stderr || "(no output)",
          success: false,
          error: parsed.error || `exit code ${code}`,
        });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
      resolve({ content: "", success: false, error: err.message });
    });
  });
}

export function parseOpenCodeOutput(stdout: string): AgentRunResult {
  const lines = stdout.split(/\r?\n/);
  const textParts: string[] = [];
  const events: unknown[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { type?: unknown; text?: unknown };
      events.push(obj);
      if (obj.type === "text" && typeof obj.text === "string") {
        textParts.push(obj.text);
      }
    } catch {
      textParts.push(trimmed);
    }
  }

  const content = textParts.join("").trim();
  return {
    content,
    success: content.length > 0,
    rawEvents: events,
  };
}
