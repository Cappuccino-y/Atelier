import { useState, useRef, useEffect, useMemo, useCallback, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { ArrowUp, Paperclip, GripHorizontal } from "lucide-react";
import type { Agent } from "@/types";
import { cn } from "@/lib/utils";

type Props = {
  agents: Agent[];
  onSend: (content: string, mentionedIds: string[]) => void;
  disabled?: boolean;
};

const MIN_HEIGHT = 110;
const MAX_HEIGHT = 320;

const MENTION_RE = /@([\w\u4e00-\u9fff]+)/g;
const MENTION_TRIGGER_RE = /@([\w\u4e00-\u9fff]*)$/;

function formatLastSeen(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function Composer({ agents, onSend, disabled }: Props) {
  const [text, setText] = useState("");
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [showDropdown, setShowDropdown] = useState(false);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const heightRef = useRef(height);
  heightRef.current = height;
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = heightRef.current;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + delta)));
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const handleResetHeight = useCallback(() => {
    setHeight(MIN_HEIGHT);
  }, []);

  const isCustomHeight = height !== MIN_HEIGHT;

  const teamAgents = useMemo(
    () => agents.filter((a) => a.id !== "user"),
    [agents]
  );

  const candidates = useMemo(() => {
    const q = mentionQuery.toLowerCase();
    return teamAgents.filter(
      (a) => q === "" || a.name.toLowerCase().includes(q)
    );
  }, [teamAgents, mentionQuery]);

  const mentionedAgents = useMemo(() => {
    const out: Agent[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(MENTION_RE)) {
      const a = teamAgents.find(
        (x) => x.name.toLowerCase() === m[1].toLowerCase()
      );
      if (a && !seen.has(a.id)) {
        seen.add(a.id);
        out.push(a);
      }
    }
    return out;
  }, [text, teamAgents]);

  // No JS height manipulation — CSS flex handles textarea growth. The textarea
// is flex-1 inside the composer column, so it fills whatever vertical space
// is available (default small, bigger when user drags). Content beyond the
// visible area scrolls internally.

  function detectMention(value: string, caret: number) {
    const before = value.slice(0, caret);
    const match = MENTION_TRIGGER_RE.exec(before);
    if (!match) return null;
    return { start: match.index, query: match[1] };
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setText(value);
    const caret = e.target.selectionStart ?? value.length;
    const detected = detectMention(value, caret);
    if (detected) {
      setMentionStart(detected.start);
      setMentionQuery(detected.query);
      setShowDropdown(true);
      setHighlightIdx(0);
    } else {
      setShowDropdown(false);
      setMentionStart(null);
    }
  }

  function selectMention(agent: Agent) {
    if (mentionStart == null || !textareaRef.current) return;
    const el = textareaRef.current;
    const caret = el.selectionStart ?? text.length;
    const before = text.slice(0, mentionStart);
    const after = text.slice(caret);
    const inserted = `@${agent.name} `;
    const next = `${before}${inserted}${after}`;
    setText(next);
    setShowDropdown(false);
    setMentionStart(null);
    setHighlightIdx(0);
    const caretPos = before.length + inserted.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caretPos, caretPos);
    });
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (showDropdown && candidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMention(candidates[highlightIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowDropdown(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function parseMentions(content: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const m of content.matchAll(MENTION_RE)) {
      const a = teamAgents.find(
        (x) => x.name.toLowerCase() === m[1].toLowerCase()
      );
      if (a && !seen.has(a.id)) {
        ids.push(a.id);
        seen.add(a.id);
      }
    }
    return ids;
  }

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed, parseMentions(trimmed));
    setText("");
    setShowDropdown(false);
    setMentionStart(null);
  }

  const hasText = text.trim().length > 0;
  const dropdownActive = showDropdown && candidates.length > 0;
  const hasMentions = mentionedAgents.length > 0;

  return (
    <div className="border-t border-zinc-200/80 bg-white relative">
      <div
        onMouseDown={handleResizeMouseDown}
        onDoubleClick={handleResetHeight}
        className={cn(
          "absolute -top-1.5 left-0 right-0 h-3 z-10 flex items-center justify-center cursor-row-resize group",
          "transition-colors"
        )}
        title="Drag to resize · double-click to reset"
      >
        <GripHorizontal
          className={cn(
            "h-3 w-4 text-zinc-300 group-hover:text-zinc-500 transition-colors",
            isCustomHeight && "text-indigo-400 group-hover:text-indigo-500"
          )}
        />
      </div>

      {dropdownActive && (
        <div className="absolute bottom-full left-4 mb-2 bg-white border border-zinc-200/70 shadow-xl shadow-zinc-200/50 rounded-xl py-1 w-72 z-50 overflow-hidden">
          {candidates.map((a, idx) => (
            <button
              key={a.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                selectMention(a);
              }}
              onMouseEnter={() => setHighlightIdx(idx)}
              className={cn(
                "w-full text-left px-3 py-1.5 text-[13px] flex items-center gap-2.5 transition-colors",
                idx === highlightIdx
                  ? "bg-indigo-50 text-indigo-900"
                  : "text-zinc-700 hover:bg-zinc-50"
              )}
            >
              <span
                className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-white shrink-0"
                style={{ background: a.color }}
              >
                {a.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="flex flex-col min-w-0 flex-1">
                <span className="font-medium truncate">{a.name}</span>
                <span className="text-[10px] text-zinc-500 truncate">
                  {a.role}
                  {a.lastSeen && a.status === "offline" && (
                    <>
                      {" · "}
                      {formatLastSeen(a.lastSeen)}
                    </>
                  )}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      <div
        className="px-4 py-3 relative flex flex-col min-h-0"
        style={{ height }}
      >
      {hasMentions && (
        <div className="flex items-center gap-1.5 mb-2 flex-wrap shrink-0">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-500 mr-0.5">
            Active
          </span>
          {mentionedAgents.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200/70"
            >
              <span
                className="h-4 w-4 rounded-full flex items-center justify-center text-[9px] font-semibold text-white"
                style={{ background: a.color }}
              >
                {a.name.slice(0, 1).toUpperCase()}
              </span>
              {a.name}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-col bg-zinc-50/80 border border-zinc-200/80 rounded-xl focus-within:border-indigo-300 focus-within:bg-white focus-within:shadow-sm transition-all flex-1 min-h-0 overflow-hidden">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKey}
          onBlur={() => {
            blurTimeoutRef.current = setTimeout(
              () => setShowDropdown(false),
              150
            );
          }}
          onFocus={() => {
            if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
          }}
          placeholder="Message the team — try @Atlas to mention"
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:outline-none px-3 pt-2 pb-1 overflow-y-auto min-h-0"
        />
        <div className="flex items-center gap-2 px-2 pb-1.5 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            tabIndex={-1}
            aria-label="Attach file"
            className="h-7 w-7 text-zinc-400 hover:text-zinc-700 rounded-lg shrink-0"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </Button>
          <div className="flex-1" />
          <Button
            type="button"
            onClick={handleSend}
            disabled={disabled || !hasText}
            aria-label="Send"
            className={cn(
              "h-9 w-9 rounded-full shrink-0 transition-all duration-150",
              hasText
                ? "bg-indigo-600 hover:bg-indigo-700 text-white shadow-[0_4px_14px_-4px_rgba(99,102,241,0.55)] hover:shadow-[0_6px_18px_-4px_rgba(99,102,241,0.7)]"
                : "bg-zinc-200 text-zinc-400 cursor-not-allowed shadow-none"
            )}
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.75} />
          </Button>
        </div>
      </div>
      </div>
    </div>
  );
}
