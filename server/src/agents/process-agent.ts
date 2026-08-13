import { spawn, execFile, type ChildProcess } from "node:child_process";
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
  atlas: `[DECISION] 收到，拆分为实现任务。\n\n{"schemaVersion":"2.0","to":["forge"],"taskSummary":"实现需求（mock）","requiredOutputSchema":"result_block"}`,
  forge: `[RESULT] 实现完成（mock）。变更：新增 2 个文件，修改 1 个函数。\n\n{"schemaVersion":"2.0","to":["lens"],"taskSummary":"review 上述实现（mock）","requiredOutputSchema":"review_block"}`,
  lens: `[REVIEW]\n- **minor**: 命名一致性\n  - location: src/foo.ts:42\n  - quote: const a = 1\n  - suggested: 改为 const count = 1\n\nLens 全部 minor，无需返工。`,
  echo: `[QUESTION] 这个问题需要更多信息。\n\n{"schemaVersion":"2.0","to":["atlas"],"taskSummary":"澄清需求（mock）","requiredOutputSchema":"answer_text"}`,
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
      killTree(child);
    }, timeoutMs);

    // external abort (Stop button)
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const emit = opts.onEvent;

    // brace-balanced JSON parser: opencode emits concatenated JSON objects whose
    // string values (text deltas, tool state.output) often contain literal
    // newlines. A naive split-by-line approach shreds those objects and falls
    // back to emitting raw JSON fragments as text_delta, polluting the agent's
    // message body. Walk the buffer tracking `{}` depth + string/escape state
    // so embedded newlines don't break us.
    let jsonBuf = "";
    const handleObj = (obj: any) => {
      const o = obj as {
        type?: string;
        part?: { type?: string; text?: string; tool?: string; state?: { input?: unknown; output?: unknown; title?: string } };
        error?: { message?: string } | string;
      };
      const partType = o.part?.type;
      if (o.type === "step_start") {
        emit?.({ type: "step_start", step: partType ?? "step" });
      } else if (o.type === "text" && typeof o.part?.text === "string") {
        emit?.({ type: "text_delta", delta: o.part.text });
      } else if (o.type === "tool_use" || partType === "tool") {
        emit?.({
          type: "tool_use",
          tool: o.part?.tool ?? "tool",
          input: o.part?.state?.input,
          output: o.part?.state?.output,
        });
      } else if (o.type === "step_finish") {
        const reason = (o.part as { reason?: string })?.reason ?? "stop";
        emit?.({ type: "step_finish", reason });
      } else if (o.type === "error") {
        const msg = extractErrorMsg(o.error) || "opencode error";
        emit?.({ type: "error", message: msg });
      }
    };

    if (child.stdout) {
      child.stdout.on("data", (d) => {
        const chunk = d.toString();
        stdout += chunk;
        jsonBuf += chunk;
        // drain all complete objects currently in the buffer
        let progress = true;
        while (progress) {
          const { consumed, objects } = consumeJsonObjects(jsonBuf);
          for (const obj of objects) handleObj(obj);
          jsonBuf = jsonBuf.slice(consumed);
          progress = objects.length > 0;
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

      // flush any leftover JSON objects in the buffer
      {
        const { objects } = consumeJsonObjects(jsonBuf);
        for (const obj of objects) handleObj(obj);
        jsonBuf = "";
      }

      if (aborted) {
        // The agent was stopped (Stop button). Content should be the
        // streamed text so far, NOT the raw JSON event stream — dumping
        // stdout here pollutes the message with `{"type":"step_start",...}`
        // JSON and makes the reply look like a crash. Parse it like a
        // normal completion, then mark it cancelled.
        const partial = parseOpenCodeOutput(stdout);
        resolve({
          content: partial.content,
          success: false,
          error: "aborted by user",
          cancelled: true,
          rawEvents: partial.rawEvents,
        });
        return;
      }
      if (killed) {
        // Same reasoning as abort: surface the streamed text, not raw JSON.
        const partial = parseOpenCodeOutput(stdout);
        resolve({
          content: partial.content,
          success: false,
          error: `timeout after ${timeoutMs}ms`,
          rawEvents: partial.rawEvents,
        });
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
  const { objects: events } = consumeJsonObjects(stdout);
  const textParts: string[] = [];
  const errors: string[] = [];

  for (const obj of events as Array<{
    type?: unknown;
    text?: unknown;
    part?: { type?: unknown; text?: unknown };
    error?: { message?: string } | string;
  }>) {
    // opencode json format: { "type":"text", "part": { "type":"text", "text":"..." } }
    const partText = obj.part?.text;
    if (obj.type === "text" && typeof partText === "string") {
      textParts.push(partText);
    } else if (obj.type === "text" && typeof obj.text === "string") {
      // fallback for older formats
      textParts.push(obj.text);
    } else if (obj.type === "error") {
      // opencode reports failures as `{"type":"error","error":{...}}` events on
      // STDOUT — NOT stderr. Swallowing these is why a failed run showed the
      // useless "(no output)" instead of the actual error. Surface them.
      const msg = extractErrorMsg(obj.error);
      if (msg) errors.push(msg);
    }
  }

  const content = textParts.join("").trim();
  if (content.length > 0) {
    return { content, success: true, rawEvents: events };
  }
  if (errors.length > 0) {
    return { content: errors.join("; "), success: false, error: errors.join("; "), rawEvents: events };
  }
  return {
    content,
    success: false,
    rawEvents: events,
  };
}

/**
 * Pull a readable message out of opencode's `error` field. opencode nests
 * the message in several shapes:
 *   - `"error": "string"`
 *   - `"error": {"message": "..."}`
 *   - `"error": {"name":"...", "data": {"message": "...", "ref": "..."}}`
 * Returns "" when nothing readable is present.
 */
function extractErrorMsg(err: unknown): string {
  if (typeof err === "string") return err.trim();
  if (!err || typeof err !== "object") return "";
  const o = err as Record<string, any>;
  if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
  if (o.data && typeof o.data === "object") {
    if (typeof o.data.message === "string" && o.data.message.trim()) return o.data.message.trim();
    try { return JSON.stringify(o.data).slice(0, 300); } catch { /* fall through */ }
  }
  try { return JSON.stringify(o).slice(0, 300); } catch { return ""; }
}

/**
 * Consume all complete top-level JSON objects from the start of `buf`.
 *
 * opencode's `--format json` mode emits concatenated JSON events with no
 * delimiter; each event is one `{...}` whose string values may contain
 * literal newlines (multi-line text deltas, pretty-printed tool output).
 * Splitting by `\n` shreds them. We walk the buffer tracking brace depth
 * and string/escape state, returning each completed object. Malformed
 * regions are skipped past so a single bad event doesn't deadlock the
 * stream.
 */
export function consumeJsonObjects(buf: string): { consumed: number; objects: any[] } {
  const objects: any[] = [];
  let cursor = 0;

  while (cursor < buf.length) {
    // skip whitespace / delimiters between events
    let objStart = cursor;
    while (objStart < buf.length && buf[objStart] !== "{") objStart++;
    if (objStart >= buf.length) {
      return { consumed: buf.length, objects };
    }

    // find the matching closing `}` respecting strings + escapes
    let depth = 0;
    let inString = false;
    let escape = false;
    let i = objStart;
    for (; i < buf.length; i++) {
      const c = buf[i];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (c === "\\") { escape = true; continue; }
        if (c === '"') { inString = false; continue; }
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }

    if (i >= buf.length) {
      // incomplete object — preserve from objStart so we retry after more data
      return { consumed: objStart, objects };
    }

    const candidate = buf.slice(objStart, i + 1);
    try {
      objects.push(JSON.parse(candidate));
      cursor = i + 1;
    } catch {
      // malformed JSON at this boundary — skip past and try the next object
      cursor = i + 1;
    }
  }

  return { consumed: buf.length, objects };
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
  killTree(child);
  activeChildren.delete(runId);
  return true;
}

/**
 * Kill the process AND its children. On Windows child.kill() only kills the
 * immediate cmd.exe shim — the spawned `opencode` grandchild keeps running
 * and holds the stdout pipe, so the parent's 'close' event never fires and
 * the run promise hangs forever (leaking the agent's running slot). taskkill
 * /T walks the whole process tree.
 */
function killTree(child: ChildProcess): void {
  try {
    if (child.pid == null) return;
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    } else {
      child.kill("SIGKILL");
    }
  } catch { /* ignore */ }
}