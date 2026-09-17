import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Agent } from "@/types";
import { StreamingMarkdown } from "./StreamingMarkdown";

/**
 * One inline card per LIVE agent run, rendered after the last message.
 * Parallel runs (e.g. two Forge instances) each get their OWN card keyed by
 * runId — streams never interleave (industry pattern: LangChain DeepAgents
 * subagent cards / AG-UI inline subagent cards / Cloudflare agents-as-tools).
 * Cards disappear when the run settles (the final message replaces them).
 */
export type StreamingCardData = {
  key: string;
  agent: Agent;
  runId?: string;
  startedAt: number;
  tool?: string;
  toolInput?: string | null;
  /** clean streamed text so far (SDK text deltas, reasoning filtered) */
  textTail?: string;
  /** "#2" suffix for parallel same-role instances */
  instanceLabel?: string;
};

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function StreamingCard({ card, now }: { card: StreamingCardData; now: number }) {
  const [open, setOpen] = useState(true);
  const { agent } = card;
  const tail = card.textTail?.trim();

  return (
    <div
      className="mx-4 mb-2 rounded-xl border border-zinc-200/80 bg-zinc-50/60 overflow-hidden"
      data-testid={`streaming-card-${card.key}`}
    >
      {/* header — click to collapse the stream body */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/80 transition-colors"
      >
        <span className="relative flex shrink-0">
          <span
            className="h-6 w-6 rounded-md flex items-center justify-center text-[9px] font-bold text-white"
            style={{ background: agent.color }}
          >
            {agent.name.slice(0, 2).toUpperCase()}
          </span>
          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-indigo-500 ring-2 ring-zinc-50 animate-pulse" />
        </span>
        <span className="text-[12.5px] font-semibold text-zinc-800 shrink-0">
          {agent.name}
          {card.instanceLabel && (
            <span className="text-zinc-400 font-mono text-[10.5px] ml-0.5">{card.instanceLabel}</span>
          )}
        </span>
        {card.tool && (
          <code className="text-[10px] leading-none px-1.5 py-0.5 rounded bg-zinc-200/70 border border-zinc-200 text-zinc-500 font-mono max-w-[90px] truncate shrink-0">
            {card.tool}
          </code>
        )}
        {card.toolInput && (
          <code className="text-[10.5px] font-mono text-indigo-600 truncate min-w-0 flex-1 hidden md:inline" title={card.toolInput}>
            {card.toolInput}
          </code>
        )}
        <span className="flex-1 md:hidden" />
        <span className="text-[10.5px] text-zinc-400 tabular-nums shrink-0">
          {fmtElapsed(now - card.startedAt)}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
        )}
      </button>

      {/* live stream body — real markdown (streaming-safe), tool rows as chips */}
      {open && (
        <div className="px-3 pb-2.5 pt-0.5 border-t border-zinc-200/60">
          {tail ? (
            <div className="prose-chat text-[12.5px] leading-relaxed text-zinc-600 max-h-56 overflow-y-auto">
              <StreamingMarkdown text={tail} streaming className="prose-chat" />
            </div>
          ) : card.tool ? (
            <div className="flex items-center gap-1.5 pt-1.5 text-[11.5px] text-zinc-500">
              <Wrench className="h-3 w-3 text-zinc-400" />
              <span>
                running <code className="font-mono text-[11px]">{card.tool}</code>
                {card.toolInput && (
                  <> — <code className="font-mono text-[11px] text-indigo-600">{card.toolInput}</code></>
                )}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1 pt-1.5 text-[11.5px] text-zinc-400">
              thinking
              <span className="typing-dot inline-block h-1 w-1 rounded-full bg-zinc-300" />
              <span className="typing-dot inline-block h-1 w-1 rounded-full bg-zinc-300" />
              <span className="typing-dot inline-block h-1 w-1 rounded-full bg-zinc-300" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function StreamingCards({ cards }: { cards: StreamingCardData[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sorted = [...cards].sort((a, b) => a.startedAt - b.startedAt);
  return (
    <div className="pt-1">
      {sorted.map(card => (
        <StreamingCard key={card.key} card={card} now={now} />
      ))}
    </div>
  );
}
