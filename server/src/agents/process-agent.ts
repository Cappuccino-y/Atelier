import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";

export type AgentEvent =
  | { type: "step_start"; step: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_use"; tool: string; input?: unknown; output?: unknown }
  | { type: "step_finish"; reason: string }
  | { type: "error"; message: string };

export type AgentRunOptions = {
  agentName: string;
  opencodeAgent: string;
  model?: string;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  onEvent?: (event: AgentEvent) => void;
  /** external abort signal — caller can stop generation */
  signal?: AbortSignal;
  /** registry key for killRun() — caller should generate (e.g. nanoid) */
  runId?: string;
};

export type AgentRunResult = {
  content: string;
  success: boolean;
  error?: string;
  /** true when the run was aborted via AbortSignal (Stop button) */
  cancelled?: boolean;
  rawEvents?: unknown[];
};

const MOCK_RESPONSES: Record<string, string> = {
  atlas: "[DECISION] 收到。让 Forge 去实现，@Forge 实现这个需求。\n\n[RESULT] 已分派给 Forge。",
  forge: "[RESULT] 实现完成（mock）。变更：新增 2 个文件，修改 1 个函数。\n\n@Lens 请 review。",
  lens: "[REVIEW]\n- **minor**: 命名一致性\n  - location: src/foo.ts:42\n  - quote: const a = 1\n  - suggested: 改为 const count = 1\n\n@Atlas 收尾。",
  echo: "[QUESTION] 这个问题需要更多信息。\n\n@Atlas 帮我确认下细节。",
};

export async function runOpenCodeAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  if (config.agentRuntime === "mock") {
    // simulate streaming for mock so UI flow is exercised end-to-end
    if (opts.onEvent) {
      opts.onEvent({ type: "step_start", step: "thinking" });
      const text = MOCK_RESPONSES[opts.agentName.toLowerCase()] ?? "[RESULT] 完成（mock）。";
      for (const ch of text) {
        if (opts.signal?.aborted) {
          return { content: "", success: false, error: "aborted by user", cancelled: true };
        }
        opts.onEvent({ type: "text_delta", delta: ch });
        await new Promise(r => setTimeout(r, 8));
      }
      opts.onEvent({ type: "step_finish", reason: "stop" });
    }
    if (opts.signal?.aborted) {
      return { content: "", success: false, error: "aborted by user", cancelled: true };
    }
    return mockResponse(opts);
  }
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
    let aborted = false;

    const child: ChildProcess = spawn("cmd.exe", ["/d", "/s", "/c", batFile], {
      windowsHide: true,
      cwd,
      env: { ...process.env },
    });
    if (opts.runId) registerRun(opts.runId, child);

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    // external abort (Stop button)
    const onAbort = () => {
      aborted = true;
      try { child.kill("SIGKILL"); } catch {}
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const emit = opts.onEvent;

    // line-buffered parser: opencode emits one JSON object per stdout chunk
    let lineBuf = "";
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed) as {
          type?: string;
          part?: { type?: string; text?: string; tool?: string; state?: { input?: unknown; output?: unknown; title?: string } };
          error?: { message?: string } | string;
        };
        const partType = obj.part?.type;
        if (obj.type === "step_start") {
          emit?.({ type: "step_start", step: partType ?? "step" });
        } else if (obj.type === "text" && typeof obj.part?.text === "string") {
          emit?.({ type: "text_delta", delta: obj.part.text });
        } else if (obj.type === "tool_use" || partType === "tool") {
          emit?.({
            type: "tool_use",
            tool: obj.part?.tool ?? "tool",
            input: obj.part?.state?.input,
            output: obj.part?.state?.output,
          });
        } else if (obj.type === "step_finish") {
          const reason = (obj.part as { reason?: string })?.reason ?? "stop";
          emit?.({ type: "step_finish", reason });
        } else if (obj.type === "error") {
          const msg = typeof obj.error === "string"
            ? obj.error
            : (obj.error?.message ?? "opencode error");
          emit?.({ type: "error", message: msg });
        }
      } catch {
        // raw text fallback for non-JSON lines (single-shot CLI mode)
        if (trimmed) emit?.({ type: "text_delta", delta: trimmed + "\n" });
      }
    };

    if (child.stdout) {
      child.stdout.on("data", (d) => {
        const chunk = d.toString();
        stdout += chunk;
        lineBuf += chunk;
        let nl = lineBuf.indexOf("\n");
        while (nl >= 0) {
          handleLine(lineBuf.slice(0, nl));
          lineBuf = lineBuf.slice(nl + 1);
          nl = lineBuf.indexOf("\n");
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (d) => {
        const chunk = d.toString();
        stderr += chunk;
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) emit?.({ type: "error", message: trimmed });
        }
      });
    }

    child.on("close", (code) => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

      // flush trailing line if any
      if (lineBuf.trim()) handleLine(lineBuf);

      if (aborted) {
        resolve({ content: stdout, success: false, error: "aborted by user", cancelled: true });
        return;
      }
      if (killed) {
        resolve({ content: stdout, success: false, error: `timeout after ${timeoutMs}ms` });
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
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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
      const obj = JSON.parse(trimmed) as {
        type?: unknown;
        text?: unknown;
        part?: { type?: unknown; text?: unknown };
        error?: unknown;
      };
      events.push(obj);
      // opencode json format: { "type":"text", "part": { "type":"text", "text":"..." } }
      const partText = obj.part?.text;
      if (obj.type === "text" && typeof partText === "string") {
        textParts.push(partText);
      } else if (obj.type === "text" && typeof obj.text === "string") {
        // fallback for older formats
        textParts.push(obj.text);
      }
    } catch {
      // non-JSON lines: treat as raw text (single-shot CLI mode)
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

/* ---- registry for cross-process cancellation ----------------------------- */

const activeChildren = new Map<string, ChildProcess>();

export function registerRun(runId: string, child: ChildProcess): void {
  activeChildren.set(runId, child);
  child.once("close", () => activeChildren.delete(runId));
}

export function killRun(runId: string): boolean {
  const child = activeChildren.get(runId);
  if (!child) return false;
  try { child.kill("SIGKILL"); } catch {}
  activeChildren.delete(runId);
  return true;
}