import { useEffect, useMemo, useState } from "react";
import { Square, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Agent } from "@/types";

/** Raw run tracked from WS events / persisted activities (App-level state). */
export type LiveRun = {
  key: string;
  roomId: string;
  agentId: string;
  runId?: string;
  startedAt: number;
  lastEventAt: number;
  lastTool?: string;
};

/** Display shape resolved against the agent roster. */
export type RunningRun = {
  key: string;
  agent: Agent;
  startedAt: number;
  lastEventAt: number;
  runId?: string;
  tool?: string;
  /** one-line tool input summary (e.g. the bash command being executed) */
  toolInput?: string | null;
  textTail?: string;
  /** "#2" suffix when the same role runs in parallel */
  instanceLabel?: string;
};

const STALL_MS = 8 * 60_000;

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function RunRow({ run, now, onStop }: {
  run: RunningRun;
  now: number;
  onStop?: (agentId: string, runId?: string) => void;
}) {
  const stalled = now - run.lastEventAt > STALL_MS;
  const tail = run.textTail?.trim();
  return (
    <div
      className="relative flex items-start gap-2.5 px-3 py-2 min-w-0 hover:bg-white/70 transition-colors"
      data-testid={`running-card-${run.key}`}
    >
      {/* agent-colored accent — pulses while the run is alive */}
      <span
        className={cn(
          "absolute left-0 top-2 bottom-2 w-[3px] rounded-full",
          !stalled && "agent-pulse",
        )}
        style={{ background: run.agent.color, color: run.agent.color }}
        aria-hidden
      />
      <div
        className="h-8 w-8 rounded-lg flex items-center justify-center text-[11px] font-semibold shrink-0 ml-1 mt-0.5"
        style={{ background: `${run.agent.color}1f`, color: run.agent.color }}
      >
        {run.agent.name.slice(0, 2).toUpperCase()}
      </div>
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-semibold text-zinc-900 shrink-0">
            {run.agent.name}
            {run.instanceLabel && (
              <span className="text-zinc-400 font-mono text-[11px] ml-0.5">{run.instanceLabel}</span>
            )}
          </span>
          {run.agent.role && (
            <span className="text-[10.5px] text-zinc-400 truncate hidden lg:inline">{run.agent.role}</span>
          )}
          <span className="flex-1" />
          {stalled && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 bg-amber-100/80 border border-amber-200 rounded-full px-1.5 py-0.5 shrink-0">
              <TriangleAlert className="h-2.5 w-2.5" />
              stalled?
            </span>
          )}
          <span className="text-[10.5px] text-zinc-400 tabular-nums shrink-0">
            {fmtElapsed(now - run.startedAt)}
          </span>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          {run.tool && (
            <code className="text-[10px] leading-none px-1.5 py-1 rounded-md bg-zinc-200/60 border border-zinc-200 text-zinc-500 font-mono max-w-[110px] truncate shrink-0">
              {run.tool}
            </code>
          )}
          {run.toolInput && (
            <code
              className="text-[10.5px] leading-none px-1.5 py-1 rounded-md bg-indigo-50 border border-indigo-100 text-indigo-700 font-mono min-w-0 flex-1 truncate"
              title={run.toolInput}
            >
              {run.toolInput}
            </code>
          )}
          {!run.toolInput && tail && (
            <span
              className={cn(
                "text-[11.5px] truncate min-w-0 flex-1",
                stalled ? "text-zinc-400" : "shimmer-text",
              )}
            >
              {tail}
            </span>
          )}
          {!run.toolInput && !tail && (
            !stalled && (
              <span className="text-[11px] text-zinc-400 flex items-center gap-1 min-w-0">
                thinking
                <span className="typing-dot inline-block h-1 w-1 rounded-full bg-zinc-300" />
                <span className="typing-dot inline-block h-1 w-1 rounded-full bg-zinc-300" />
                <span className="typing-dot inline-block h-1 w-1 rounded-full bg-zinc-300" />
              </span>
            )
          )}
        </div>
      </div>
      {onStop && (
        <button
          onClick={() => onStop(run.agent.id, run.runId)}
          title={`Stop ${run.agent.name}${run.instanceLabel ?? ""}`}
          className="shrink-0 h-6 w-6 rounded-full flex items-center justify-center text-zinc-300 hover:text-red-600 hover:bg-red-50 transition-colors mt-1"
        >
          <Square className="h-2.5 w-2.5 fill-current" />
        </button>
      )}
    </div>
  );
}

/**
 * Live strip pinned directly above the composer — visually an extension of
 * it (same width, same muted zinc surface, same rounded language). One
 * two-line row per run (runId-granular, so parallel same-role instances each
 * get a row); a scanning progress line on the top edge signals activity.
 */
export function RunningDock({ runs, onStopAgent, onStopAll }: {
  runs: RunningRun[];
  onStopAgent?: (agentId: string, runId?: string) => void;
  onStopAll?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (runs.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [runs.length]);

  const sorted = useMemo(
    () => [...runs].sort((a, b) => a.startedAt - b.startedAt),
    [runs],
  );

  if (runs.length === 0) return null;

  return (
    <div className="px-4 pt-2 pb-0 bg-white" data-testid="running-dock">
      <div className="relative rounded-t-xl border border-b-0 border-zinc-200/80 bg-zinc-50/80 overflow-hidden">
        {/* scanning progress line — the "working" cue */}
        <div className="absolute top-0 inset-x-0 h-[2px] overflow-hidden" aria-hidden>
          <div
            className="h-full w-1/4 rounded-full animate-scan-x"
            style={{
              background:
                "linear-gradient(90deg, transparent, #818cf8 45%, #a5b4fc 55%, transparent)",
            }}
          />
        </div>
        <div className="flex items-center gap-2 px-3 pt-1.5 pb-1">
          <span className="text-[11px] font-semibold text-zinc-500">
            {runs.length} agent{runs.length === 1 ? "" : "s"} running
          </span>
          <span className="flex-1" />
          {onStopAll && (
            <button
              onClick={onStopAll}
              title="Stop all running agents"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-400 hover:text-red-600 transition-colors px-1.5 py-0.5 rounded-md hover:bg-red-50"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
              Stop all
            </button>
          )}
        </div>
        <div className="divide-y divide-zinc-200/60">
          {sorted.map(run => (
            <RunRow key={run.key} run={run} now={now} onStop={onStopAgent} />
          ))}
        </div>
      </div>
    </div>
  );
}
