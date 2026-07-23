import { useState, useRef, useEffect, useMemo, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Send, Paperclip } from "lucide-react";
import type { Agent } from "@/types";
import { cn } from "@/lib/utils";

type Props = {
  agents: Agent[];
  onSend: (content: string, mentionedIds: string[]) => void;
  disabled?: boolean;
};

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
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [text]);

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
    <div className="border-t border-zinc-200/80 bg-white px-4 py-3 relative">
      {hasMentions && (
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
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

      <div className="flex items-end gap-2 bg-zinc-50/80 border border-zinc-200/80 rounded-xl px-2 py-1.5 focus-within:border-indigo-300 focus-within:bg-white focus-within:shadow-sm transition-all">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          tabIndex={-1}
          aria-label="Attach file"
          className="h-8 w-8 text-zinc-400 hover:text-zinc-700 rounded-lg shrink-0"
        >
          <Paperclip className="h-4 w-4" />
        </Button>
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
          className="flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:outline-none py-1.5 px-1 max-h-40 min-h-6"
        />
        <Button
          type="button"
          onClick={handleSend}
          disabled={disabled || !hasText}
          aria-label="Send"
          className={cn(
            "h-9 w-9 rounded-full shrink-0 transition-all duration-150",
            hasText
              ? "bg-indigo-600 hover:bg-indigo-700 text-white shadow-[0_4px_14px_-4px_rgba(99,102,241,0.55)] hover:shadow-[0_6px_18px_-4px_rgba(99,102,241,0.7)]"
              : "bg-zinc-200 text-zinc-400 hover:bg-zinc-200 cursor-not-allowed shadow-none"
          )}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
