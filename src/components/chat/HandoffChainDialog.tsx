import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Waypoints, ArrowDown, CircleAlert } from "lucide-react";
import { api } from "@/lib/api";
import { cn, formatTime } from "@/lib/utils";
import type { Agent, Message } from "@/types";

type ChainNode = {
  messageId: string;
  parentId: string | null;
  authorId: string;
  content: string;
  tags: string[];
  timestamp: number;
  handoffSummary?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  message: Message | null;
  agents: Agent[];
};

const TAG_BADGE: Record<string, string> = {
  RESULT: "bg-emerald-50 text-emerald-700 border-emerald-200",
  REVIEW: "bg-rose-50 text-rose-700 border-rose-200",
  QUESTION: "bg-cyan-50 text-cyan-700 border-cyan-200",
  DECISION: "bg-violet-50 text-violet-700 border-violet-200",
  BLOCKER: "bg-red-50 text-red-700 border-red-200",
  TODO: "bg-amber-50 text-amber-700 border-amber-200",
  STATUS: "bg-zinc-100 text-zinc-600 border-zinc-200",
  RESEARCH: "bg-teal-50 text-teal-700 border-teal-200",
  ANALYSIS: "bg-orange-50 text-orange-700 border-orange-200",
  DOCUMENT: "bg-blue-50 text-blue-700 border-blue-200",
  VISUAL: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
  MEMORY: "bg-indigo-50 text-indigo-700 border-indigo-200",
};

export function HandoffChainDialog({ open, onClose, message, agents }: Props) {
  const [chain, setChain] = useState<ChainNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !message) return;
    setChain(null);
    setError(null);
    let cancelled = false;
    api.handoffChain(message.id)
      .then(r => { if (!cancelled) setChain(r.chain); })
      .catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [open, message]);

  const agentMap = new Map(agents.map(a => [a.id, a]));

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Waypoints className="h-4 w-4 text-indigo-500" />
            Handoff chain
          </DialogTitle>
          <DialogDescription>
            Root → leaf provenance for this message (parent-chain walk).
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mx-1 px-1">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700">
              <CircleAlert className="h-4 w-4 mt-0.5 shrink-0" />
              Failed to load chain: {error}
            </div>
          )}
          {!chain && !error && (
            <div className="space-y-2 py-1">
              {[40, 64, 56].map((h, i) => (
                <div key={i} className="shimmer rounded-lg" style={{ height: h }} />
              ))}
            </div>
          )}
          {chain && chain.length === 0 && (
            <p className="text-[12.5px] text-muted-foreground py-2">
              No provenance — this message starts its own chain.
            </p>
          )}
          {chain && chain.length > 0 && (
            <ol className="relative space-y-1 py-1">
              {chain.map((node, i) => {
                const agent = agentMap.get(node.authorId);
                const name = agent?.name ?? node.authorId;
                const color = agent?.color ?? "#94a3b8";
                const preview = node.content
                  .replace(/```[\s\S]*?```/g, "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 220);
                return (
                  <li key={node.messageId} className="relative pl-6">
                    {/* rail */}
                    {i < chain.length - 1 && (
                      <span className="absolute left-[9px] top-6 bottom-[-4px] w-px bg-zinc-200" />
                    )}
                    <span
                      className="absolute left-0.5 top-2 h-[15px] w-[15px] rounded-full ring-2 ring-white shadow-sm"
                      style={{ background: color }}
                      title={name}
                    />
                    <div className="rounded-lg border border-zinc-200/80 bg-white px-3 py-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[12px] font-semibold text-zinc-800">{name}</span>
                        <span className="text-[10.5px] text-zinc-400">{formatTime(node.timestamp)}</span>
                        {i === chain.length - 1 && (
                          <span className="tag-badge bg-indigo-50 text-indigo-600 border-indigo-200">this message</span>
                        )}
                        {(node.tags ?? []).map(t => (
                          <span key={t} className={cn("tag-badge", TAG_BADGE[t] ?? "bg-zinc-100 text-zinc-600")}>
                            {t.toLowerCase()}
                          </span>
                        ))}
                      </div>
                      {preview && (
                        <p className="mt-1 text-[11.5px] leading-snug text-zinc-500 line-clamp-2">{preview}…</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {chain && chain.length > 1 && (
          <p className="text-[10.5px] text-zinc-400 flex items-center gap-1 shrink-0">
            <ArrowDown className="h-3 w-3" />
            {chain.length} hops in this task chain
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
