/**
 * Agent execution layer — opencode server/SDK runtime.
 *
 * Replaces the legacy one-shot `opencode run` subprocess approach. We now
 * talk to a shared, long-lived `opencode serve` process over HTTP + SSE:
 *
 *   - no stdout pipe parsing (the whole #44601 EOF-vs-exit bug family dies)
 *   - `session.abort()` instead of taskkill trees (clean cancel semantics)
 *   - tool events carry their input natively (bash command visibility)
 *   - sessions persist server-side (context survives across prompts)
 *
 * The public surface (runOpenCodeAgent / AgentEvent / AgentRunOptions /
 * AgentRunResult / abortRun / listRuns ...) is unchanged — callers in
 * runtime.ts, summarizer.ts, triggers.ts and routes/* need no edits.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { config } from "../config.js";
import { debugLog } from "./debug.js";

export type AgentEvent =
  | { type: "step_start"; step: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_use"; tool: string; input?: unknown; output?: unknown; silent?: boolean }
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
  /** roomId for stop-by-room lookups (alias registry) */
  roomId?: string;
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
  return runServerAgent(opts);
}

function mockResponse(opts: AgentRunOptions): AgentRunResult {
  const key = opts.agentName.toLowerCase();
  return {
    content: MOCK_RESPONSES[key] ?? "[RESULT] 完成（mock）。",
    success: true,
  };
}

/* ------------------------------------------------------------------ */
/* Shared opencode server (lazy singleton)                             */
/* ------------------------------------------------------------------ */

let serverProc: ChildProcess | null = null;
let serverClient: OpencodeClient | null = null;
let serverUrl: string | null = null;
let serverStarting: Promise<OpencodeClient> | null = null;

/**
 * Spawn `opencode serve` once and reuse it for every agent run. The server
 * inherits our environment (provider keys, user-level opencode.json with the
 * 9-agent definitions + permission matrix), so agent configs behave exactly
 * like they did under `opencode run`.
 */
async function getOpencodeClient(): Promise<OpencodeClient> {
  if (serverClient) return serverClient;
  if (serverStarting) return serverStarting;

  serverStarting = (async () => {
    // Windows: the npm-global opencode CLI is an opencode.cmd shim — CreateProcess
    // cannot exec it directly (ENOENT, observed 2026-09-18), and the old
    // `type prompt | opencode run` path worked only because cmd.exe resolved the
    // shim. Route through cmd.exe for the serve spawn too. Args are constants.
    const proc = process.platform === "win32"
      ? spawn("opencode serve --hostname=127.0.0.1", { shell: true, windowsHide: true, env: { ...process.env } })
      : spawn("opencode", ["serve", "--hostname=127.0.0.1"], { windowsHide: true, env: { ...process.env } });
    const output = { text: "" };
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`opencode serve startup timeout (60s): ${output.text.slice(0, 400)}`)), 60_000);
      const onData = (chunk: unknown) => {
        output.text += String(chunk);
        const m = output.text.match(/opencode server listening on (https?:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      // spawn failures (ENOENT etc.) arrive via the 'error' event, and 'exit'
      // may never fire — without this listener Node treats it as unhandled
      // and KILLS THE WHOLE SERVER PROCESS (observed 2026-09-18).
      proc.once("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`failed to spawn opencode serve: ${err.message}`));
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`opencode serve exited early (code ${code}): ${output.text.slice(0, 400)}`));
      });
    });

    proc.once("exit", (code) => {
      debugLog("opencode-server", undefined, undefined, "shared server exited", { code, url });
      serverProc = null;
      serverClient = null;
      serverUrl = null;
      serverStarting = null;
      // next run re-spawns lazily via getOpencodeClient()
    });

    serverProc = proc;
    serverUrl = url;
    // CRITICAL: Node's built-in fetch (undici) enforces a 300s body timeout
    // by default. Long forge turns routinely exceed 5 minutes — the prompt
    // fetch AND the SSE stream both died at exactly ~305s ("fetch failed"),
    // leaving mid-sentence content that failed schema validation and looped
    // retries. A dedicated Agent with no timeouts fixes this.
    const noTimeoutAgent = new UndiciAgent({
      headersTimeout: 0,
      bodyTimeout: 0,
    });
    const undiciFetchNoTimeout = (input: any, init?: any) => {
      // SDK passes a Request object; undici's fetch needs URL + expanded init
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const merged: Record<string, unknown> = init
        ? { ...init }
        : {
            method: input.method,
            headers: input.headers,
            body: input.body,
            duplex: "half",
          };
      merged.dispatcher = noTimeoutAgent;
      return undiciFetch(u, merged as any);
    };
    serverClient = createOpencodeClient({
      baseUrl: url,
      fetch: undiciFetchNoTimeout as unknown as typeof fetch,
    });
    debugLog("opencode-server", undefined, undefined, "shared server started", { url, pid: proc.pid });
    return serverClient;
  })();

  return serverStarting;
}

/** Best-effort shutdown (used by tests / graceful restart). */
export function stopSharedServer(): void {
  if (serverProc) {
    const pid = serverProc.pid;
    try {
      if (pid && process.platform === "win32") {
        // shell:true wraps opencode in cmd.exe — killing the wrapper alone
        // leaves the serve grandchild orphaned. Kill the whole tree.
        spawn(`taskkill /PID ${pid} /T /F`, { shell: true, windowsHide: true, stdio: "ignore" });
      } else {
        serverProc.kill();
      }
    } catch { /* ignore */ }
    serverProc = null;
    serverClient = null;
    serverUrl = null;
    serverStarting = null;
  }
}

/** Debug accessor: current shared server URL (null when not running). */
export function getServerUrlForDebug(): string | null {
  return serverUrl;
}

/* ------------------------------------------------------------------ */
/* Run registry (sessions instead of child processes)                  */
/* ------------------------------------------------------------------ */

/** runId → live session id, for abort/kill lookups. */
const activeSessions = new Map<string, string>();
/** roomKey (`roomId:agentId` or bare `agentId`) → runId, for stop-by-room-agent */
const activeByRoomAgent = new Map<string, string>();
/** runId → abort state (user interrupt vs timeout vs natural end) */
const activeAbort = new Map<string, { aborted: boolean; timedOut: boolean }>();
/** runId → run metadata for the /api/runtime/runs liveness endpoint. */
const activeMeta = new Map<
  string,
  { roomId?: string; agentId?: string; startedAt: number; lastTool?: string; lastInput?: string }
>();

function cleanupRun(runId: string, keys: string[]): void {
  activeSessions.delete(runId);
  activeAbort.delete(runId);
  activeMeta.delete(runId);
  for (const k of keys) {
    if (activeByRoomAgent.get(k) === runId) activeByRoomAgent.delete(k);
  }
}

/** Snapshot of currently-live runs for the liveness endpoint. */
export function listRuns(): Array<{
  runId: string; roomId?: string; agentId?: string; startedAt: number; lastTool?: string; lastInput?: string;
}> {
  const out: Array<{
    runId: string; roomId?: string; agentId?: string; startedAt: number; lastTool?: string; lastInput?: string;
  }> = [];
  for (const [runId, meta] of activeMeta) {
    if (!activeSessions.has(runId)) continue; // cleanup pending — treat as dead
    out.push({
      runId,
      roomId: meta.roomId,
      agentId: meta.agentId,
      startedAt: meta.startedAt,
      lastTool: meta.lastTool,
      lastInput: meta.lastInput,
    });
  }
  return out;
}

/** Update a run's last-seen tool + input summary (drives interrupt reports). */
export function noteRunTool(runId: string, tool: string, inputSummary?: string): void {
  const meta = activeMeta.get(runId);
  if (!meta) return;
  meta.lastTool = tool;
  if (inputSummary) meta.lastInput = inputSummary;
}

/** Compact one-line summary of a tool call input (server-side mirror of the
 *  frontend's summarizeToolInput — used for interrupt reports). */
export function summarizeToolInput(tool: string, input: unknown): string | undefined {
  if (input == null || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const firstStr = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  };
  let s: string | undefined;
  switch (tool) {
    case "bash": s = firstStr("command", "cmd", "script"); break;
    case "read":
    case "write":
    case "edit": s = firstStr("filePath", "file_path", "path", "notebook_path"); break;
    case "glob": s = firstStr("pattern"); break;
    case "grep": s = firstStr("pattern", "query"); break;
    default: s = firstStr("command", "query", "url", "path", "pattern", "description", "prompt");
  }
  if (!s) return undefined;
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** Abort a run — asks the opencode server to abort the session. The run
 *  resolves as cancelled:true (a deliberate user interrupt, NOT a failure). */
export function abortRun(runId: string): boolean {
  const sessionId = activeSessions.get(runId);
  if (!sessionId) return false;
  const state = activeAbort.get(runId);
  if (state) state.aborted = true;
  // fire-and-forget: the SSE stream sees the abort and the run settles
  void (async () => {
    try {
      const client = await getOpencodeClient();
      await client.session.abort({ path: { id: sessionId } });
      debugLog("opencode-abort", undefined, undefined, "session.abort sent", { runId, sessionId });
    } catch (err) {
      debugLog("opencode-abort", undefined, undefined, "session.abort failed", {
        runId, sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // server unreachable → force-settle via timeout path is not possible
      // here; the run's own timeout backstop will fire if truly hung.
    }
  })();
  return true;
}

/** Abort by room/agent key (or any alias) — resolves to a runId first. */
export function abortRunByKey(key: string): boolean {
  const runId = activeByRoomAgent.get(key);
  if (!runId) return false;
  return abortRun(runId);
}

/** Hard kill — for the SDK runtime this degrades to abort (there is no
 *  process tree to taskkill; the server owns the session). */
export function killRun(runId: string): boolean {
  return abortRun(runId);
}

/** Kill by room/agent key (or any alias) — resolves to a runId first. */
export function killRunByKey(key: string): boolean {
  return abortRunByKey(key);
}

/* ------------------------------------------------------------------ */
/* Model parsing                                                       */
/* ------------------------------------------------------------------ */

/** Split "provider/model" (e.g. "custom-saas/glm-5.3-flash-saas"). When no
 *  slash is present the model is left unpinned — the server falls back to the
 *  user-level opencode.json default model. */
function splitModel(model?: string): { providerID?: string; modelID?: string } {
  if (!model) return {};
  const idx = model.indexOf("/");
  if (idx <= 0 || idx === model.length - 1) return { modelID: model };
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

/* ------------------------------------------------------------------ */
/* The real agent run (server/SDK)                                     */
/* ------------------------------------------------------------------ */

async function runServerAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const client = await getOpencodeClient();

  // Pin every agent run to <workspace>/rooms/<roomId>/ — generated files and
  // projects stay out of the repo tree, and concurrent rooms get isolated
  // working directories. Falls back to the repo root for runs without a room.
  let cwd: string;
  if (opts.roomId) {
    cwd = join(config.agentWorkspace, "rooms", opts.roomId);
    try { mkdirSync(cwd, { recursive: true }); } catch {}
  } else {
    cwd = opts.cwd ?? process.cwd();
  }
  const timeoutMs = opts.timeoutMs ?? config.opencodeTimeout;
  const model = splitModel(opts.model ?? config.opencodeModel);
  const runId = opts.runId ?? `run_${Date.now().toString(36)}`;
  const emit = opts.onEvent;

  debugLog("opencode-cmd", opts.roomId, opts.agentName, "creating session", {
    opencodeAgent: opts.opencodeAgent,
    model: opts.model ?? config.opencodeModel,
    cwd,
    timeoutMs,
    runId,
  });

  // 1. create session pinned to the room workspace
  const session = await client.session.create({ query: { directory: cwd } });
  const sessionId = session.data!.id;

  // 2. register in the run registry (abort + liveness + aliases)
  const abortState = { aborted: false, timedOut: false };
  activeSessions.set(runId, sessionId);
  activeAbort.set(runId, abortState);
  activeMeta.set(runId, { roomId: opts.roomId, agentId: opts.agentName, startedAt: Date.now() });
  const keys = [opts.agentName];
  if (opts.roomId) keys.unshift(`${opts.roomId}:${opts.agentName}`);
  for (const k of keys) activeByRoomAgent.set(k, runId);

  // 3. subscribe to the SSE stream and filter events for this session.
  //    One stream per run keeps cleanup simple (close when the run ends);
  //    opencode handles many concurrent SSE clients without issue.
  //    NOTE: /global/event (project-agnostic bus) is the one that carries
  //    message/session traffic for sessions in arbitrary room directories —
  //    the directory-scoped /event stream only emits server-level frames.
  const stream = await client.global.event();
  const streamOk = !!stream.stream;
  if (!streamOk) {
    cleanupRun(runId, keys);
    return { content: "", success: false, error: "opencode event stream unavailable" };
  }

  const textParts: string[] = [];
  const errors: string[] = [];
  let sawAssistantError = false;
  let settled = false;
  // per-run stream dedupe state (hoisted above the SSE consumer)
  const toolSeen = new Set<string>();
  const toolOutputs = new Map<string, unknown>();
  /** partID → part type, so reasoning deltas can be excluded from content */
  const ssePartTypes = new Map<string, string>();
  /** last text partID seen — a switch to a new partID means the model started
   *  a new narration segment; inject a paragraph break between them */
  let currentTextPartId: string | undefined;

  const settle = (result: AgentRunResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
    cleanupRun(runId, keys);
    try {
      // stream is an async iterable — break it via abort of the reader
      void stream.stream.return?.(undefined as never);
    } catch { /* ignore */ }
    debugLog("opencode-close", opts.roomId, opts.agentName, "run settled", {
      runId, sessionId, success: result.success, cancelled: result.cancelled,
      error: result.error, contentLen: result.content.length,
      aborted: abortState.aborted, timedOut: abortState.timedOut,
    });
    resolve(result);
  };

  let resolve!: (r: AgentRunResult) => void;
  const runPromise = new Promise<AgentRunResult>((r) => { resolve = r; });

  const timer = setTimeout(() => {
    abortState.timedOut = true;
    // ask server to abort the session; settle immediately with partial text
    void (async () => {
      try {
        await client.session.abort({ path: { id: sessionId } });
      } catch { /* ignore */ }
      const content = textParts.join("").trim();
      settle({
        content,
        success: false,
        error: `timeout after ${timeoutMs}ms`,
        rawEvents: undefined,
      });
    })();
  }, timeoutMs);
  timer.unref?.();

  const onExternalAbort = () => {
    abortState.aborted = true;
    void client.session.abort({ path: { id: sessionId } }).catch(() => {});
  };
  if (opts.signal) {
    if (opts.signal.aborted) onExternalAbort();
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  // 4. consume SSE events for this session.
  //    SDK wraps each SSE frame as { payload: { type, properties } } —
  //    unwrap defensively (older SDKs exposed the payload directly).
  const consume = (async () => {
    try {
      for await (const frame of stream.stream as AsyncIterable<{ payload?: any; type?: string; properties?: any }>) {
        if (settled) break;
        const wrapper = frame as { payload?: any };
        const event = wrapper.payload ?? frame;
        const props = event.properties ?? {};
        const evType = event.type ?? "";

        if (evType === "message.updated" && props.info?.sessionID === sessionId) {
          const info = props.info;
          if (info.role === "assistant" && info.error) {
            sawAssistantError = true;
            const msg = extractErrorMsg(info.error);
            if (msg) {
              errors.push(msg);
              emit?.({ type: "error", message: msg });
            }
          }
        }
        if (evType === "session.error" && props.sessionID === sessionId) {
          sawAssistantError = true;
          const msg = extractErrorMsg(props.error);
          if (msg) {
            errors.push(msg);
            emit?.({ type: "error", message: msg });
          }
        }

        if (evType === "message.part.delta" && props.sessionID === sessionId) {
          // streaming delta: { sessionID, messageID, partID, field, delta }.
          // Only field==="text" on a TEXT part is reply content — reasoning
          // deltas (field "text" on a reasoning part) must NOT leak in.
          if (props.field === "text" && typeof props.delta === "string" && props.delta.length > 0) {
            if (ssePartTypes.get(props.partID) === "reasoning") continue;
            // opencode emits each inter-tool narration as a SEPARATE text part,
            // and consecutive parts arrive with NO separator — the reply comes
            // out as a 2000-char single line ("paragraph fusion"). When the
            // stream switches to a NEW text part, inject a paragraph break.
            if (currentTextPartId && currentTextPartId !== props.partID) {
              textParts.push("\n\n");
              emit?.({ type: "text_delta", delta: "\n\n" });
            }
            currentTextPartId = props.partID;
            textParts.push(props.delta);
            emit?.({ type: "text_delta", delta: props.delta });
          }
        }

        if (evType === "message.part.updated" && props.part?.sessionID === sessionId) {
          const part = props.part;
          // track partID → type so part.delta frames can be classified
          // (reasoning deltas must NOT leak into the reply content)
          if (part.id) ssePartTypes.set(part.id, part.type);
          if (part.type === "step-start") {
            emit?.({ type: "step_start", step: "step" });
          } else if (part.type === "step-finish") {
            emit?.({ type: "step_finish", reason: part.reason ?? "stop" });
          } else if (part.type === "tool") {
            const toolName = part.tool ?? "tool";
            const toolInput = part.state?.input;
            const toolOutput = part.state?.output;
            const status = part.state?.status;
            // surface each tool call once, then refresh when it completes.
            // the pending frame has empty input — wait for running/completed
            // so the UI gets the actual command text.
            const key = part.callID ?? `${toolName}:${part.id}`;
            const meaningful = status === "running" || status === "completed" || status === "error";
            if (!toolSeen.has(key) && meaningful) {
              toolSeen.add(key);
              toolOutputs.set(key, toolOutput);
              emit?.({ type: "tool_use", tool: toolName, input: toolInput, output: toolOutput });
            } else if (status === "completed" || status === "error") {
              toolOutputs.set(key, toolOutput);
              emit?.({ type: "tool_use", tool: toolName, input: toolInput, output: toolOutput, silent: true });
            }
          }
          // text/reasoning part.updated frames are cumulative snapshots —
          // the part.delta stream below already covers them; skip here.
        }

        if (evType === "session.idle" && props.sessionID === sessionId) {
          break;
        }
      }
    } catch (err) {
      if (!settled) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog("opencode-stream", opts.roomId, opts.agentName, "SSE consume error", { runId, sessionId, error: msg });
        errors.push(`event stream error: ${msg}`);
      }
    }
  })();

  // 5. send the prompt (this triggers the agent loop on the server).
  //    prompt() resolves when the turn completes; we don't rely on that —
  //    the SSE loop settles first. But we await it to catch request-level
  //    failures (400s, auth errors).
  try {
    await client.session.prompt({
      path: { id: sessionId },
      query: { directory: cwd },
      body: {
        parts: [{ type: "text", text: opts.prompt }],
        ...(opts.opencodeAgent ? { agent: opts.opencodeAgent } : {}),
        ...(model.providerID && model.modelID
          ? { model: { providerID: model.providerID, modelID: model.modelID } }
          : {}),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog("opencode-prompt", opts.roomId, opts.agentName, "prompt failed", { runId, sessionId, error: msg });
    errors.push(msg);
  }

  // 6. settle: prompt resolved (success/idle) or errored
  const content = textParts.join("").trim();
  if (abortState.aborted) {
    settle({ content, success: false, error: "aborted by user", cancelled: true });
  } else if (errors.length > 0 && content.length === 0) {
    settle({ content: errors.join("; "), success: false, error: errors.join("; ") });
  } else if (content.length > 0) {
    settle({ content, success: !sawAssistantError, error: sawAssistantError ? errors.join("; ") : undefined });
  } else if (errors.length > 0) {
    settle({ content: errors.join("; "), success: false, error: errors.join("; ") });
  } else {
    settle({
      content: "",
      success: false,
      error: `model returned no output (session ${sessionId}, ${sawAssistantError ? "assistant error" : "no error event"})`,
    });
  }

  void consume;
  return runPromise;
}

/** Test-only exports (internal helpers surfaced for unit tests). */
export { extractErrorMsg as extractErrorMsgForTest, splitModel as splitModelForTest };

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
