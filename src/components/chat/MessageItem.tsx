import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn, formatTime } from "@/lib/utils";
import {
  Copy,
  MapPin,
  Quote,
  CheckCircle2,
  FileCode,
  FilePlus,
  FileMinus,
  AlertOctagon,
  AlertCircle,
  Circle,
  MessageCircleQuestion,
  Diamond,
  Check,
  X,
  Waypoints,
} from "lucide-react";
import { useState, useCallback, useEffect, memo } from "react";
import { api } from "@/lib/api";
import type { Message, Agent, Finding, MessageReactions } from "@/types";

type Props = {
  message: Message;
  author?: Agent;
  mentionedAgents?: Agent[];
  isGrouped?: boolean;
  index?: number;
  onReply?: (text: string, targetAgentName: string) => void;
  onShowChain?: (message: Message) => void;
};

const SEVERITY_STYLE: Record<string, { bar: string; badge: string }> = {
  critical: { bar: "bg-red-500", badge: "bg-red-50 text-red-700 border-red-200" },
  major: { bar: "bg-amber-500", badge: "bg-amber-50 text-amber-700 border-amber-200" },
  minor: { bar: "bg-sky-500", badge: "bg-sky-50 text-sky-700 border-sky-200" },
};

function stripTag(text: string, tag: string): string {
  const re = new RegExp(`\\[${tag}\\][：:]?\\s*`, "i");
  return text.replace(re, "").trim();
}

function elapsedSince(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 1000) return "now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function extractFileSummary(content: string): {
  files: { kind: "added" | "modified" | "removed"; count: number }[];
  remainder: string;
} {
  const patterns: {
    re: RegExp;
    kind: "added" | "modified" | "removed";
  }[] = [
    {
      re: /(?:新增|added|new)\s+(\d+)\s+(?:个\s*)?(?:文件|files?)/i,
      kind: "added",
    },
    {
      re: /(?:修改|modified|changed|updated)\s+(\d+)\s+(?:个\s*)?(?:文件|files?)/i,
      kind: "modified",
    },
    {
      re: /(?:删除|removed|deleted)\s+(\d+)\s+(?:个\s*)?(?:文件|files?)/i,
      kind: "removed",
    },
  ];
  const files: { kind: "added" | "modified" | "removed"; count: number }[] = [];
  let remainder = content;
  for (const p of patterns) {
    const m = remainder.match(p.re);
    if (m) {
      files.push({ kind: p.kind, count: parseInt(m[1], 10) });
      remainder = remainder.replace(p.re, "").trim();
    }
  }
  return { files, remainder };
}

/**
 * Models frequently emit the handoff contract as an inline JSON object in
 * prose (`... 并行派出： {"schemaVersion":"2.0", ...}`). Extract the first
 * balanced `{...}` object that looks like a handoff payload (must parse and
 * carry a `to` field) so it can be rendered as a structured card instead of
 * a wall of raw JSON, returning the remaining prose.
 */
function extractInlineHandoff(content: string): { payload: Record<string, unknown> | null; remainder: string } {
  const start = content.indexOf('{"schemaVersion"');
  if (start < 0) return { payload: null, remainder: content };
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return { payload: null, remainder: content };
  try {
    const payload = JSON.parse(content.slice(start, end));
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as any).to)) {
      return { payload: null, remainder: content };
    }
    return { payload, remainder: (content.slice(0, start) + content.slice(end)).replace(/\s{2,}/g, " ").trim() };
  } catch {
    return { payload: null, remainder: content };
  }
}

/** Parse a fenced ```handoff block body into a payload object. */
function parseHandoffBlock(code: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(code);
    if (obj && typeof obj === "object" && Array.isArray((obj as any).to)) return obj;
    return null;
  } catch {
    return null;
  }
}

const AGENT_ROLE_COLORS: Record<string, string> = {
  atlas: "#8B5CF6", forge: "#F97316", lens: "#06B6D4", echo: "#22C55E",
  trainer: "#A855F7", scout: "#10B981", analyst: "#F59E0B", writer: "#3B82F6",
  archivist: "#6366F1", user: "#64748B",
};

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function toEntryName(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as any;
    return String(o.name ?? o.id ?? "agent");
  }
  return "agent";
}

/**
 * Structured card replacing the raw handoff JSON blob agents emit in prose.
 * Shows route targets, intent, required output schema, and budget hints.
 */
function HandoffCard({ payload }: { payload: Record<string, unknown> }) {
  const to = Array.isArray(payload.to) ? payload.to.map(toEntryName) : [];
  const taskSummary = typeof payload.taskSummary === "string"
    ? payload.taskSummary
    : typeof payload.task === "string" ? payload.task : "";
  const intent = typeof payload.intent === "string" ? payload.intent : null;
  const schema = typeof payload.requiredOutputSchema === "string" ? payload.requiredOutputSchema : null;
  const traceId = typeof payload.traceId === "string" ? payload.traceId.slice(0, 8) : null;
  const constraints = (payload.constraints && typeof payload.constraints === "object")
    ? payload.constraints as Record<string, unknown>
    : null;
  const evidence = typeof payload.evidenceStandard === "string" ? payload.evidenceStandard : null;

  return (
    <div className="relative my-1.5 rounded-[10px] border border-indigo-200/80 bg-white overflow-hidden">
      <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-indigo-500" />
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-indigo-200/60 bg-indigo-50/60">
        <Waypoints className="h-3.5 w-3.5 text-indigo-600" />
        <span className="text-[12px] font-semibold text-indigo-900">Handoff</span>
        {traceId && (
          <span className="text-[9.5px] font-mono text-zinc-400" title={String(payload.traceId)}>
            {traceId}
          </span>
        )}
        {evidence && (
          <span className="tag-badge ml-auto bg-zinc-100 text-zinc-500">{evidence}</span>
        )}
      </div>
      <div className="p-3 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10.5px] text-zinc-400 mr-0.5">→</span>
          {to.map((name, i) => (
            <span key={`${name}-${i}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10.5px] bg-indigo-50 text-indigo-700 border border-indigo-200/80">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: AGENT_ROLE_COLORS[name.toLowerCase()] ?? "#94a3b8" }}
              />
              @{name}
            </span>
          ))}
          {intent && (
            <span className="tag-badge bg-indigo-50 text-indigo-600">{intent}</span>
          )}
          {schema && (
            <span className="tag-badge bg-slate-100 text-slate-600">out:{schema}</span>
          )}
        </div>
        {taskSummary && (
          <p className="text-[12.5px] text-zinc-700 leading-relaxed line-clamp-4">{taskSummary}</p>
        )}
        {constraints && (constraints.maxTokens != null || constraints.deadlineMs != null) && (
          <p className="text-[10px] text-zinc-400">
            {constraints.maxTokens != null && <span className="mr-2">budget ≤{String(constraints.maxTokens)} tokens</span>}
            {constraints.deadlineMs != null && <span>deadline {(Number(constraints.deadlineMs) / 1000).toFixed(0)}s</span>}
          </p>
        )}
      </div>
    </div>
  );
}


function DiffCard({
  authorName,
  content,
  timestamp,
  handoffTo,
}: {
  authorName: string;
  content: string;
  timestamp: number;
  handoffTo?: Agent;
}) {
  const { files, remainder } = extractFileSummary(stripTag(content, "RESULT"));
  return (
    <div className="relative my-1.5 rounded-[10px] border border-emerald-200/80 bg-white overflow-hidden">
      <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-emerald-500" />
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-emerald-200/60 bg-emerald-50/60">
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
        <span className="text-[12px] font-semibold text-emerald-900">
          Result
        </span>
        <span className="text-[11px] text-zinc-500">· {authorName}</span>
        <span className="text-[10.5px] text-zinc-400 ml-auto">
          {elapsedSince(timestamp)}
        </span>
      </div>
      <div className="p-3 space-y-1.5">
        {files.length > 0 && (
          <div className="space-y-1">
            {files.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-[12.5px]">
                {f.kind === "added" && (
                  <FilePlus className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                )}
                {f.kind === "modified" && (
                  <FileCode className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                )}
                {f.kind === "removed" && (
                  <FileMinus className="h-3.5 w-3.5 text-red-600 shrink-0" />
                )}
                <span className="font-mono text-zinc-700">
                  {f.kind === "added" ? "+" : f.kind === "modified" ? "~" : "-"}
                  {f.count} {f.kind}
                </span>
              </div>
            ))}
          </div>
        )}
        {remainder && (
          <pre className="text-[12px] font-mono text-zinc-700 bg-zinc-50 border border-zinc-200 rounded-md p-2 overflow-x-auto whitespace-pre-wrap">
            {remainder}
          </pre>
        )}
      </div>
      {handoffTo && (
        <div className="px-3 py-1.5 border-t border-zinc-200/60 bg-zinc-50/50 text-[10.5px] text-zinc-500">
          Handed off to{" "}
          <span className="font-medium text-zinc-700">@{handoffTo.name}</span>
        </div>
      )}
    </div>
  );
}

function ReviewLane({ roomId, messageId, findings, onOptimistic }: {
  roomId: string;
  messageId: string;
  findings: Finding[];
  onOptimistic?: (index: number | "all", decision: "accepted" | "rejected") => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const decide = useCallback(async (index: number | "all", decision: "accepted" | "rejected") => {
    const key = `${index}:${decision}`;
    if (busyKey) return;
    setBusyKey(key);
    onOptimistic?.(index, decision);
    try {
      await api.decideFinding(roomId, messageId, index, decision);
    } catch {
      /* server broadcast will reconcile; decisions surface via message.updated */
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, roomId, messageId, onOptimistic]);

  const allDecided = findings.every(f => f.decision);

  return (
    <div className="my-1.5 space-y-1">
      <div className="flex items-center gap-2 px-1">
        <span className="h-2 w-2 rounded-full bg-rose-500" />
        <span className="text-[12px] font-semibold text-zinc-900">Review</span>
        <span className="text-[10.5px] text-zinc-500 ml-auto">
          {findings.length} {findings.length === 1 ? "finding" : "findings"}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {findings.map((f, idx) => {
          const sev = SEVERITY_STYLE[f.severity] ?? SEVERITY_STYLE.minor;
          const decided = f.decision === "accepted" || f.decision === "rejected";
          return (
            <div
              key={idx}
              className={cn(
                "group/f relative pl-3 pr-3 py-1.5 bg-white border border-zinc-200/80 rounded-lg overflow-hidden transition-opacity",
                decided && "opacity-60"
              )}
            >
              <span
                className={cn("absolute left-0 top-0 bottom-0 w-1", sev.bar)}
              />
              <div className="flex items-center gap-2 mb-0.5">
                <span className={cn("tag-badge", sev.badge)}>{f.severity}</span>
                {f.decision && (
                  <span
                    className={cn(
                      "tag-badge",
                      f.decision === "accepted"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-zinc-100 text-zinc-500 border-zinc-200"
                    )}
                  >
                    {f.decision}
                  </span>
                )}
                <span className={cn(
                  "text-[12px] font-medium text-zinc-900",
                  f.decision === "rejected" && "line-through decoration-zinc-400"
                )}>
                  {f.title}
                </span>
                {!decided && (
                  <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/f:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={() => decide(idx, "rejected")}
                      disabled={!!busyKey}
                      title="Reject finding"
                      className="h-5 w-5 rounded flex items-center justify-center text-zinc-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
                    >
                      <X className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => decide(idx, "accepted")}
                      disabled={!!busyKey}
                      title="Accept finding — queue a rework"
                      className="h-5 w-5 rounded flex items-center justify-center text-zinc-400 hover:text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"
                    >
                      <Check className="h-3 w-3" />
                    </button>
                  </span>
                )}
              </div>
              {f.location && (
                <div className="flex items-center gap-1 text-[11px] text-zinc-500 mb-0.5">
                  <MapPin className="h-3 w-3" />
                  <code className="font-mono">{f.location}</code>
                </div>
              )}
              {f.quote && (
                <div className="flex items-start gap-1 text-[11px] mb-0.5">
                  <Quote className="h-3 w-3 mt-0.5 text-zinc-400 shrink-0" />
                  <code className="font-mono bg-zinc-50 px-1.5 py-0.5 rounded text-zinc-700">
                    {f.quote}
                  </code>
                </div>
              )}
              {f.suggested && (
                <div className="text-[11px] text-emerald-700 mt-0.5 flex items-start gap-1">
                  <span>→</span>
                  <span>{f.suggested}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!allDecided && (
        <div className="flex items-center gap-1.5 px-1 pt-0.5">
          <button
            onClick={() => decide("all", "rejected")}
            disabled={!!busyKey}
            className="text-[10.5px] font-medium px-2 py-0.5 rounded-md bg-zinc-50 text-zinc-700 border border-zinc-200 hover:bg-zinc-100 disabled:opacity-50"
          >
            Reject all
          </button>
          <button
            onClick={() => decide("all", "accepted")}
            disabled={!!busyKey}
            className="text-[10.5px] font-medium px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50"
          >
            Accept all{busyKey === `all:accepted` ? "…" : ""}
          </button>
        </div>
      )}
    </div>
  );
}

function QuestionCard({
  authorName,
  content,
  onReply,
}: {
  authorName: string;
  content: string;
  onReply?: (text: string, targetAgentName: string) => void;
}) {
  const body = stripTag(content, "QUESTION");
  const [draft, setDraft] = useState("");
  const submit = () => {
    const text = draft.trim();
    if (!text || !onReply) return;
    onReply(text, authorName);
    setDraft("");
  };
  return (
    <div className="relative my-1.5 rounded-[10px] border border-cyan-200/80 bg-white overflow-hidden">
      <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-cyan-500" />
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-cyan-200/60 bg-cyan-50/60">
        <MessageCircleQuestion className="h-3.5 w-3.5 text-cyan-600" />
        <span className="text-[12px] font-semibold text-cyan-900">
          Question from {authorName}
        </span>
      </div>
      <div className="p-3 space-y-2">
        <div className="prose-chat text-[13px] text-zinc-800 leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{body}</ReactMarkdown>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1 bg-white border border-zinc-200 rounded-md focus-within:border-cyan-400 focus-within:ring-2 focus-within:ring-cyan-100">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={`Reply to @${authorName}…`}
            className="flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-zinc-400"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="h-6 w-6 rounded-md bg-cyan-600 text-white flex items-center justify-center hover:bg-cyan-700 disabled:opacity-40 text-[12px] leading-none"
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}

function DecisionCard({
  content,
  timestamp,
}: {
  content: string;
  timestamp: number;
}) {
  const body = stripTag(content, "DECISION");
  return (
    <div className="relative my-1.5 rounded-[10px] border border-violet-200/80 bg-white overflow-hidden">
      <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-violet-500" />
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-violet-200/60 bg-violet-50/60">
        <Diamond className="h-3.5 w-3.5 text-violet-600" />
        <span className="text-[12px] font-semibold text-violet-900">
          Decision
        </span>
      </div>
      <div className="p-3 space-y-1">
        <div className="prose-chat text-[13px] text-zinc-800 leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{body}</ReactMarkdown>
        </div>
        <p className="text-[10.5px] text-zinc-500">
          Recorded at {formatTime(timestamp)}
        </p>
      </div>
    </div>
  );
}

function BlockerCard({
  content,
  mentionedAgents,
}: {
  content: string;
  mentionedAgents: Agent[];
}) {
  const body = stripTag(content, "BLOCKER");
  // Owner lookup: prefer explicit @mentions, then scan prose for any agent
  // name as a substring (model often writes "Atlas" without the @ symbol),
  // finally fall back to "Unassigned".
  const ownerName =
    mentionedAgents[0]?.name ??
    findAgentNameInText(body) ??
    null;
  return (
    <div className="relative my-1.5 rounded-[10px] border border-red-200/80 bg-white overflow-hidden">
      <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-red-500" />
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-red-200/60 bg-red-50/70">
        <AlertOctagon className="h-3.5 w-3.5 text-red-600" />
        <span className="text-[12px] font-semibold text-red-900">Blocker</span>
      </div>
      <div className="p-3 space-y-1.5">
        <div className="prose-chat text-[13px] text-zinc-800 leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{body}</ReactMarkdown>
        </div>
        <p className="text-[10.5px] text-zinc-500 flex items-center gap-1">
          <span>Owner:</span>
          {ownerName ? (
            <span className="font-medium text-zinc-700">@{ownerName}</span>
          ) : (
            <>
              <AlertCircle className="h-3 w-3 text-amber-500" />
              <span>Unassigned</span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

// Best-effort owner scan: find the first occurrence of any known agent name
// as a substring in the blocker body. We intentionally use a tiny hardcoded
// list here — pulling agent names from the Agent registry would couple this
// card to props state, and the four Atelier agents are stable.
const KNOWN_AGENT_NAMES = ["Atlas", "Forge", "Lens", "Echo"];
function findAgentNameInText(text: string): string | null {
  const lower = text.toLowerCase();
  let best: { name: string; idx: number } | null = null;
  for (const name of KNOWN_AGENT_NAMES) {
    const idx = lower.indexOf(name.toLowerCase());
    if (idx >= 0 && (best === null || idx < best.idx)) {
      best = { name, idx };
    }
  }
  return best?.name ?? null;
}

function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const match = /language-(\w+)/.exec(className ?? "");
  const language = match ? match[1] : "";
  const code = String(children).replace(/\n$/, "");
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="relative group">
      <div className="flex items-center justify-between px-3 py-1 bg-zinc-200/50 border-b border-zinc-300/50 rounded-t-lg text-[10px] text-zinc-500">
        {language ? (
          <span className="font-mono font-medium">{language}</span>
        ) : (
          <span />
        )}
        <button
          onClick={copy}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-zinc-500 hover:text-zinc-900 hover:bg-zinc-300/50 transition-colors"
        >
          <Copy className="h-3 w-3" />
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="!mt-0 !rounded-t-none">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

const markdownComponents = {
  code({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) {
    const isInline = !className;
    if (isInline) return <code className={className} {...props}>{children}</code>;
    // ```handoff fenced blocks become structured HandoffCards
    if (/language-handoff/i.test(className)) {
      const payload = parseHandoffBlock(String(children));
      if (payload) return <HandoffCard payload={payload} />;
    }
    return <CodeBlock className={className}>{children}</CodeBlock>;
  },
  img({ src, alt }: React.ImgHTMLAttributes<HTMLImageElement>) {
    return (
      <span className="inline-block max-w-full my-1">
        <img
          src={src}
          alt={alt ?? ""}
          className="max-w-full rounded-lg border border-zinc-200 shadow-sm"
          loading="lazy"
        />
      </span>
    );
  },
};

function TodoCard({ content, messageId }: { content: string; messageId: string }) {
  const body = stripTag(content, "TODO");
  // Persist checkbox across re-renders / room switches. Keyed by message id +
  // body hash so multiple TODO cards in one message don't collide.
  const storageKey = `atelier-todo:${messageId}:${hashString(body)}`;
  const [checked, setChecked] = useState(() => {
    try { return localStorage.getItem(storageKey) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try {
      if (checked) localStorage.setItem(storageKey, "1");
      else localStorage.removeItem(storageKey);
    } catch { /* private mode */ }
  }, [checked, storageKey]);
  return (
    <div className="relative my-1.5 rounded-[10px] border border-amber-200/80 bg-white overflow-hidden">
      <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-amber-500" />
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-amber-200/60 bg-amber-50/60">
        <Circle className="h-3.5 w-3.5 text-amber-600" />
        <span className="text-[12px] font-semibold text-amber-900">Todo</span>
      </div>
      <div className="p-3">
        <label className="flex items-start gap-2 cursor-pointer select-none">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              setChecked((c) => !c);
            }}
            className={cn(
              "h-4 w-4 rounded border flex items-center justify-center mt-0.5 shrink-0 transition-colors",
              checked
                ? "bg-amber-600 border-amber-600 text-white"
                : "bg-white border-zinc-300 hover:border-amber-400"
            )}
          >
            {checked && <CheckCircle2 className="h-3 w-3" />}
          </button>
          <div
            className={cn(
              "prose-chat text-[13px] text-zinc-800 leading-relaxed",
              checked && "[&_p]:line-through [&_p]:text-zinc-500"
            )}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{body}</ReactMarkdown>
          </div>
        </label>
      </div>
    </div>
  );
}

function TimelineRow({
  authorName,
  authorColor,
  content,
}: {
  authorName: string;
  authorColor: string;
  content: string;
}) {
  return (
    <div className="my-1.5 w-full">
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 rounded-full shrink-0"
          style={{ background: authorColor }}
        />
        <span className="text-[11px] uppercase tracking-wider font-semibold text-zinc-500">
          {authorName} · status
        </span>
      </div>
      <div className="mt-0.5 prose-chat text-[13.5px] leading-relaxed text-zinc-700">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {stripTag(content, "STATUS")}
        </ReactMarkdown>
      </div>
    </div>
  );
}

export const MessageItem = memo(function MessageItem({
  message,
  author,
  mentionedAgents = [],
  isGrouped,
  index = 0,
  onReply,
  onShowChain,
}: Props) {
  const isUser = message.authorId === "user";
  // Inline handoff JSON → structured card (non-user messages only).
  const extracted = isUser
    ? { payload: null as Record<string, unknown> | null, remainder: message.content }
    : extractInlineHandoff(message.content);
  const displayContent = extracted.payload ? extracted.remainder : message.content;

  // Optimistic finding decisions: applied locally immediately, then replaced
  // by the authoritative message.updated broadcast from the server.
  const [pendingFindings, setPendingFindings] = useState<Finding[] | null>(null);
  useEffect(() => { setPendingFindings(null); }, [message.id]);
  const findings: Finding[] = pendingFindings ?? message.findings ?? [];

  const handleDecide = useCallback((idx: number | "all", decision: "accepted" | "rejected") => {
    setPendingFindings(curr => {
      const base = curr ?? (message.findings ?? []);
      return base.map((f, i) =>
        idx === "all" || i === idx ? { ...f, decision } : f
      );
    });
  }, [message.findings]);

  const [copied, setCopied] = useState(false);
  const staggerDelay = Math.min(index * 30, 150);

  const authorName = author?.name ?? message.authorId;
  const authorColor = author?.color ?? "#888";
  const tags = message.tags ?? [];
  const isStatusOnly = tags.length === 1 && tags[0] === "STATUS";
  const lensHandoff = mentionedAgents.find(
    (a) => a.name.toLowerCase() === "lens"
  );

  function copy() {
    navigator.clipboard?.writeText(message.content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const renderSignalCard = (tag: string) => {
    switch (tag) {
      case "RESULT":
        return (
          <DiffCard
            key={tag}
            authorName={authorName}
            content={message.content}
            timestamp={message.timestamp}
            handoffTo={lensHandoff}
          />
        );
      case "REVIEW":
        return findings.length > 0 ? (
          <ReviewLane
            key={tag}
            roomId={message.roomId}
            messageId={message.id}
            findings={findings}
            onOptimistic={handleDecide}
          />
        ) : null;
      case "QUESTION":
        return (
          <QuestionCard
            key={tag}
            authorName={authorName}
            content={message.content}
            onReply={(text, target) => {
              // Reply routes back to the asking agent via @mention so the
              // server's mention routing picks it up.
              onReply?.(`@${target} ${text}`, target);
            }}
          />
        );
      case "DECISION":
        return (
          <DecisionCard
            key={tag}
            content={message.content}
            timestamp={message.timestamp}
          />
        );
      case "BLOCKER":
        return (
          <BlockerCard
            key={tag}
            content={message.content}
            mentionedAgents={mentionedAgents}
          />
        );
      case "TODO":
        return <TodoCard key={tag} content={message.content} messageId={message.id} />;
      case "STATUS":
        return null;
      default:
        return null;
    }
  };

  return (
    <div
      className={cn(
        "group relative flex gap-3 px-4 animate-message-in transition-colors hover:bg-zinc-50/50",
        isUser ? "flex-row-reverse" : "flex-row",
        isGrouped ? "py-0.5" : "pt-3 pb-1"
      )}
      style={{ animationDelay: `${staggerDelay}ms` }}
    >
      <div className="w-9 shrink-0 relative">
        {isGrouped && <span className="thread-line" />}
        {!isGrouped && (
          <div
            className="h-9 w-9 rounded-full flex items-center justify-center text-xs font-semibold text-white ring-2 ring-white shadow-sm"
            style={{ background: authorColor }}
          >
            {authorName.slice(0, 2).toUpperCase()}
          </div>
        )}
      </div>

      <div
        className={cn(
          "flex flex-col min-w-0",
          isUser ? "items-end max-w-[78%]" : "items-start flex-1"
        )}
      >
        {!isGrouped && (
          <div
            className={cn(
              "flex items-baseline gap-2 mb-1",
              isUser ? "flex-row-reverse" : "flex-row"
            )}
          >
            <span className="text-[13px] font-semibold text-zinc-900">
              {authorName}
            </span>
            {author?.role && (
              <span className="text-[11px] text-zinc-500">{author.role}</span>
            )}
            <span className="text-[11px] text-zinc-400">
              {formatTime(message.timestamp)}
            </span>
          </div>
        )}

        {isStatusOnly ? (
          <TimelineRow
            authorName={authorName}
            authorColor={authorColor}
            content={message.content}
          />
        ) : (
          <>
            <div
              className={cn(
                "relative w-full break-words",
                isUser
                  ? "rounded-2xl rounded-br-md px-3.5 py-2 bg-indigo-600 text-white"
                  : "py-1"
              )}
            >
              <div
                className={cn(
                  "prose-chat text-[13.5px] leading-relaxed",
                  isUser && "prose-invert"
                )}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {displayContent}
                </ReactMarkdown>
              </div>

              <div className={cn(
                "absolute -top-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity",
                isUser ? "-left-7" : "-right-7"
              )}>
                {!isUser && onShowChain && (
                  <button
                    onClick={() => onShowChain(message)}
                    className="h-6 w-6 rounded-md bg-white border border-zinc-200 shadow-sm flex items-center justify-center text-zinc-500 hover:text-indigo-600"
                    title="View handoff chain (trace)"
                  >
                    <Waypoints className="h-3 w-3" />
                  </button>
                )}
                <button
                  onClick={copy}
                  className="h-6 w-6 rounded-md bg-white border border-zinc-200 shadow-sm flex items-center justify-center text-zinc-500 hover:text-zinc-900"
                  title="Copy"
                >
                  <Copy className="h-3 w-3" />
                </button>
              </div>
              {copied && (
                <span
                  className={cn(
                    "absolute -top-7 text-[10px] bg-zinc-900 text-white px-2 py-0.5 rounded shadow",
                    isUser ? "right-0" : "left-0"
                  )}
                >
                  Copied
                </span>
              )}
            </div>

            {extracted.payload && (
              <div className="mt-1.5 animate-card-in">
                <HandoffCard payload={extracted.payload} />
              </div>
            )}

            {tags.length > 0 && (
              <div
                className={cn(
                  "mt-1.5 flex flex-col",
                  isUser ? "items-end self-end" : "items-stretch w-full"
                )}
              >
                {tags.map((tag, tagIdx) => (
                  <div key={tag} className="animate-card-in" style={{ animationDelay: `${tagIdx * 60}ms` }}>
                    {renderSignalCard(tag)}
                  </div>
                ))}
              </div>
            )}

            {mentionedAgents.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 mt-1">
                {!isUser && (
                  <span className="text-[10.5px] text-zinc-400 mr-0.5" title="Handed off to">
                    →
                  </span>
                )}
                {mentionedAgents.map((a) => (
                  <span
                    key={a.id}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10.5px] bg-indigo-50 text-indigo-700 border border-indigo-200/80"
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: a.color }}
                    />
                    @{a.name}
                  </span>
                ))}
              </div>
            )}

            {!isUser && (
              <ReactionsBar roomId={message.roomId} messageId={message.id} reactions={message.reactions} />
            )}
          </>
        )}
      </div>
    </div>
  );
});

const EMOJI_PICKER = ["👍", "🎉", "❤️", "😄", "😢", "🔥"];

function ReactionsBar({ roomId, messageId, reactions }: { roomId: string; messageId: string; reactions?: MessageReactions }) {
  const [showPicker, setShowPicker] = useState(false);
  const [localReactions, setLocalReactions] = useState<MessageReactions>(reactions ?? {});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setLocalReactions(reactions ?? {}); }, [reactions]);

  const handleReact = useCallback(async (emoji: string) => {
    if (busy) return;
    setBusy(true);
    // Optimistic toggle — flip this user's vote immediately. The server's
    // response (which is the source of truth, including other reactors)
    // re-syncs below.
    setLocalReactions(prev => {
      const next: MessageReactions = { ...prev };
      const existing = next[emoji];
      if (existing && existing.count > 0) {
        // optimistic remove: hide entirely; the server-side count from
        // other reactors will repopulate if needed
        delete next[emoji];
      } else {
        next[emoji] = { count: 1 };
      }
      return next;
    });
    try {
      const updated = await api.toggleReaction(roomId, messageId, emoji);
      if (updated.reactions) setLocalReactions(updated.reactions);
    } catch {
      setLocalReactions(reactions ?? {});
    } finally {
      setBusy(false);
    }
  }, [busy, roomId, messageId, reactions]);

  const entries = Object.entries(localReactions);
  if (entries.length === 0 && !showPicker) {
    return (
      <div className="mt-1 flex">
        <button
          onClick={() => setShowPicker(true)}
          className="text-[11px] text-zinc-400 hover:text-zinc-600 px-1 py-0.5 rounded transition-colors"
          title="Add reaction"
        >
          + Reaction
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {entries.map(([emoji, data]) => (
        <ReactionPill
          key={emoji}
          emoji={emoji}
          count={data.count}
          onClick={() => handleReact(emoji)}
          onRemove={() => handleReact(emoji)}
        />
      ))}
      <div className="relative">
        <button
          onClick={() => setShowPicker(v => !v)}
          className="text-[11px] text-zinc-400 hover:text-zinc-600 px-1 py-0.5 rounded transition-colors"
          title="Add reaction"
        >
          +
        </button>
        {showPicker && (
          <div className="absolute bottom-full left-0 mb-1 z-10 flex gap-1 bg-white border border-zinc-200 rounded-lg shadow-lg p-1.5">
            {EMOJI_PICKER.map(e => {
              const picked = entries.some(([k]) => k === e);
              return (
                <button
                  key={e}
                  onClick={() => handleReact(e)}
                  className={cn(
                    "text-base hover:scale-125 transition-transform px-1 rounded",
                    picked && "bg-indigo-100 ring-1 ring-indigo-300"
                  )}
                  title={picked ? `Remove ${e}` : `Add ${e}`}
                >
                  {e}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Single reaction chip. Hover reveals an explicit × cancel affordance so
 * the user knows how to retract their vote. Active state (scale + ring)
 * fires for 180ms after a click so the action feels acknowledged.
 */
function ReactionPill({ emoji, count, onClick, onRemove }: {
  emoji: string;
  count: number;
  onClick: () => void;
  onRemove: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title="Click to remove"
      className={cn(
        "group inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded-md text-[11px]",
        "bg-zinc-100 border border-zinc-200 text-zinc-700",
        "hover:bg-zinc-200 active:scale-95 transition-all duration-150"
      )}
    >
      <span>{emoji}</span>
      <span className="font-medium tabular-nums">{count}</span>
      <span
        role="button"
        aria-label={`Remove ${emoji}`}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="ml-0.5 -mr-0.5 w-3 h-3 flex items-center justify-center rounded-full text-zinc-400 hover:text-zinc-700 hover:bg-zinc-300/70 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        ×
      </span>
    </button>
  );
}
