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
} from "lucide-react";
import { useState } from "react";
import type { Message, Agent, Finding } from "@/types";

type Props = {
  message: Message;
  author?: Agent;
  mentionedAgents?: Agent[];
  isGrouped?: boolean;
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

function ReviewLane({ findings }: { findings: Finding[] }) {
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
          return (
            <div
              key={idx}
              className="relative pl-3 pr-3 py-1.5 bg-white border border-zinc-200/80 rounded-lg overflow-hidden"
            >
              <span
                className={cn("absolute left-0 top-0 bottom-0 w-1", sev.bar)}
              />
              <div className="flex items-center gap-2 mb-0.5">
                <span className={cn("tag-badge", sev.badge)}>{f.severity}</span>
                <span className="text-[12px] font-medium text-zinc-900">
                  {f.title}
                </span>
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
      <div className="flex items-center gap-1.5 px-1 pt-0.5">
        <button className="text-[10.5px] font-medium px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">
          Accept all
        </button>
        <button className="text-[10.5px] font-medium px-2 py-0.5 rounded-md bg-zinc-50 text-zinc-700 border border-zinc-200 hover:bg-zinc-100">
          Reject all
        </button>
      </div>
    </div>
  );
}

function QuestionCard({
  authorName,
  content,
}: {
  authorName: string;
  content: string;
}) {
  const body = stripTag(content, "QUESTION");
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
        <p className="text-[13px] text-zinc-800 leading-relaxed">{body}</p>
        <div className="flex items-center gap-1.5 px-2 py-1 bg-white border border-zinc-200 rounded-md focus-within:border-cyan-400 focus-within:ring-2 focus-within:ring-cyan-100">
          <input
            type="text"
            placeholder="Reply…"
            className="flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-zinc-400"
          />
          <button
            type="button"
            className="h-6 w-6 rounded-md bg-cyan-600 text-white flex items-center justify-center hover:bg-cyan-700 text-[12px] leading-none"
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
        <p className="text-[13px] text-zinc-800 leading-relaxed">{body}</p>
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
  const ownerName = mentionedAgents[0]?.name;
  return (
    <div className="relative my-1.5 rounded-[10px] border border-red-200/80 bg-white overflow-hidden">
      <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-red-500" />
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-red-200/60 bg-red-50/70">
        <AlertOctagon className="h-3.5 w-3.5 text-red-600" />
        <span className="text-[12px] font-semibold text-red-900">Blocker</span>
      </div>
      <div className="p-3 space-y-1.5">
        <p className="text-[13px] text-zinc-800 leading-relaxed">{body}</p>
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

function TodoCard({ content }: { content: string }) {
  const body = stripTag(content, "TODO");
  const [checked, setChecked] = useState(false);
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
          <span
            className={cn(
              "text-[13px] text-zinc-800 leading-relaxed",
              checked && "line-through text-zinc-500"
            )}
          >
            {body}
          </span>
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
    <div className="flex items-center gap-2 h-7 px-2 my-0.5 rounded-md bg-zinc-50/70 border border-zinc-200/60">
      <span
        className="h-2 w-2 rounded-full shrink-0"
        style={{ background: authorColor }}
      />
      <span className="text-[12px] font-medium text-zinc-700">{authorName}</span>
      <span className="text-[11.5px] text-zinc-500">· status update</span>
      <span className="text-[12px] text-zinc-600 truncate min-w-0 flex-1">
        {stripTag(content, "STATUS")}
      </span>
    </div>
  );
}

export function MessageItem({
  message,
  author,
  mentionedAgents = [],
  isGrouped,
}: Props) {
  const isUser = message.authorId === "user";
  const findings: Finding[] = message.findings ?? [];
  const [copied, setCopied] = useState(false);

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
          <ReviewLane key={tag} findings={findings} />
        ) : null;
      case "QUESTION":
        return (
          <QuestionCard
            key={tag}
            authorName={authorName}
            content={message.content}
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
        return <TodoCard key={tag} content={message.content} />;
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
    >
      <div className="w-9 shrink-0">
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
                  : cn(
                      "pl-3 pr-1 py-1",
                      !isGrouped && "border-l-2 border-zinc-200"
                    )
              )}
            >
              <div
                className={cn(
                  "prose-chat text-[13.5px] leading-relaxed",
                  isUser && "prose-invert"
                )}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {message.content}
                </ReactMarkdown>
              </div>

              <button
                onClick={copy}
                className={cn(
                  "absolute -top-3 opacity-0 group-hover:opacity-100 transition-opacity",
                  "h-6 w-6 rounded-md bg-white border border-zinc-200 shadow-sm flex items-center justify-center text-zinc-500 hover:text-zinc-900",
                  isUser ? "-left-7" : "-right-7"
                )}
                title="Copy"
              >
                <Copy className="h-3 w-3" />
              </button>
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

            {tags.length > 0 && (
              <div
                className={cn(
                  "mt-1.5 flex flex-col",
                  isUser ? "items-end self-end" : "items-stretch w-full"
                )}
              >
                {tags.map(renderSignalCard)}
              </div>
            )}

            {mentionedAgents.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
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
          </>
        )}
      </div>
    </div>
  );
}
