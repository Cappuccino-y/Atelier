import { useEffect, useMemo, useState, type ComponentType, type KeyboardEvent } from "react";
import {
  Search,
  Hash,
  Bot,
  CheckSquare,
  MessageSquare,
  Plus,
  Settings,
  ScanSearch,
  Repeat2,
  PanelRight,
  Download,
  CornerDownLeft,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn, cjkAwareCompare, highlightMatch, truncate } from "@/lib/utils";
import type { Agent, CommandItem, Message, Room, Task } from "@/types";

type Filter = "all" | "rooms" | "agents" | "tasks" | "commands";

type Props = {
  open: boolean;
  onClose: () => void;
  rooms: Room[];
  messages: Message[];
  tasks: Task[];
  agents?: Agent[];
  onSelectRoom: (id: string) => void;
  onCreateRoom?: () => void;
  onReview?: () => void;
  onExport?: () => void;
  onToggleSelfTalk?: () => void;
  onToggleRightPanel?: () => void;
};

const ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  Search,
  Hash,
  Bot,
  CheckSquare,
  MessageSquare,
  Plus,
  Settings,
  ScanSearch,
  Repeat2,
  PanelRight,
  Download,
};

const GROUP_ORDER: Array<{ kind: CommandItem["kind"]; label: string }> = [
  { kind: "room", label: "Rooms" },
  { kind: "agent", label: "Agents" },
  { kind: "task", label: "Tasks" },
  { kind: "message", label: "Messages" },
  { kind: "command", label: "Commands" },
];

const PILLS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "rooms", label: "Rooms" },
  { id: "agents", label: "Agents" },
  { id: "tasks", label: "Tasks" },
  { id: "commands", label: "Commands" },
];

export function CommandBar(props: Props) {
  const {
    open,
    onClose,
    rooms,
    messages,
    tasks,
    agents = [],
    onSelectRoom,
    onCreateRoom,
    onReview,
    onExport,
    onToggleSelfTalk,
    onToggleRightPanel,
  } = props;

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [highlightIdx, setHighlightIdx] = useState(0);

  const allCommands = useMemo<CommandItem[]>(
    () => [
      {
        id: "cmd.rightPanel",
        kind: "command",
        title: "Toggle Right Panel",
        subtitle: "Action",
        icon: "PanelRight",
        hint: "⌘\\",
        action: onToggleRightPanel,
      },
      {
        id: "cmd.selfTalk",
        kind: "command",
        title: "Toggle Self-Talk",
        subtitle: "Action",
        icon: "Repeat2",
        action: onToggleSelfTalk,
      },
      {
        id: "cmd.review",
        kind: "command",
        title: "Review last output",
        subtitle: "Action",
        icon: "ScanSearch",
        action: onReview,
      },
      {
        id: "cmd.create",
        kind: "command",
        title: "Create new room",
        subtitle: "Action",
        icon: "Plus",
        action: onCreateRoom,
      },
      {
        id: "cmd.export",
        kind: "command",
        title: "Export current room",
        subtitle: "Action",
        icon: "Download",
        action: onExport,
      },
      {
        id: "cmd.settings",
        kind: "command",
        title: "Open settings",
        subtitle: "Action",
        icon: "Settings",
      },
    ],
    [onToggleRightPanel, onToggleSelfTalk, onReview, onCreateRoom, onExport],
  );

  const recentRooms = useMemo<CommandItem[]>(
    () =>
      rooms.slice(0, 5).map((r) => ({
        id: r.id,
        kind: "room",
        title: r.name,
        subtitle: r.topic ?? "Room",
        icon: "Hash",
        payload: r,
      })),
    [rooms],
  );

  const flatItems = useMemo<CommandItem[]>(() => {
    const q = query.trim();
    const isEmpty = !q;

    if (isEmpty) {
      switch (filter) {
        case "all":
          return [...recentRooms, ...allCommands];
        case "rooms":
          return recentRooms;
        case "agents":
          return agents.map<CommandItem>((a) => ({
            id: a.id,
            kind: "agent",
            title: a.name,
            subtitle: a.role,
            icon: "Bot",
            payload: a,
          }));
        case "tasks":
          return tasks.map<CommandItem>((t) => ({
            id: t.id,
            kind: "task",
            title: t.title,
            subtitle: t.status,
            icon: "CheckSquare",
            payload: t,
          }));
        case "commands":
          return allCommands;
      }
    }

    const ql = q.toLowerCase();
    const out: CommandItem[] = [];

    if (filter === "all" || filter === "rooms") {
      for (const r of rooms) {
        if (
          r.name.toLowerCase().includes(ql) ||
          (r.topic ?? "").toLowerCase().includes(ql)
        ) {
          out.push({
            id: r.id,
            kind: "room",
            title: r.name,
            subtitle: r.topic ?? "Room",
            icon: "Hash",
            payload: r,
          });
        }
      }
    }
    if (filter === "all" || filter === "agents") {
      for (const a of agents) {
        if (a.name.toLowerCase().includes(ql) || a.role.toLowerCase().includes(ql)) {
          out.push({
            id: a.id,
            kind: "agent",
            title: a.name,
            subtitle: a.role,
            icon: "Bot",
            payload: a,
          });
        }
      }
    }
    if (filter === "all" || filter === "tasks") {
      for (const t of tasks) {
        if (t.title.toLowerCase().includes(ql)) {
          out.push({
            id: t.id,
            kind: "task",
            title: t.title,
            subtitle: t.status,
            icon: "CheckSquare",
            payload: t,
          });
        }
      }
    }
    if (filter === "all") {
      for (const m of messages) {
        if (m.content.toLowerCase().includes(ql)) {
          out.push({
            id: m.id,
            kind: "message",
            title: truncate(m.content, 60),
            subtitle: m.authorId,
            icon: "MessageSquare",
            payload: m,
          });
        }
      }
    }
    if (filter === "all" || filter === "commands") {
      for (const c of allCommands) {
        if (c.title.toLowerCase().includes(ql)) {
          out.push(c);
        }
      }
    }

    out.sort((a, b) => {
      const aStart = a.title.toLowerCase().startsWith(ql) ? 0 : 1;
      const bStart = b.title.toLowerCase().startsWith(ql) ? 0 : 1;
      if (aStart !== bStart) return aStart - bStart;
      return cjkAwareCompare(a.title, b.title);
    });

    return out.slice(0, 50);
  }, [query, filter, rooms, agents, tasks, messages, recentRooms, allCommands]);

  const grouped = useMemo(() => {
    const map = new Map<CommandItem["kind"], Array<{ item: CommandItem; idx: number }>>();
    flatItems.forEach((item, idx) => {
      const arr = map.get(item.kind) ?? [];
      arr.push({ item, idx });
      map.set(item.kind, arr);
    });
    return GROUP_ORDER.filter((g) => map.has(g.kind)).map((g) => ({
      label: g.label,
      kind: g.kind,
      entries: map.get(g.kind)!,
    }));
  }, [flatItems]);

  useEffect(() => {
    setHighlightIdx(0);
  }, [query, filter, open]);

  useEffect(() => {
    if (flatItems.length === 0) {
      if (highlightIdx !== 0) setHighlightIdx(0);
      return;
    }
    if (highlightIdx >= flatItems.length) {
      setHighlightIdx(flatItems.length - 1);
    }
  }, [flatItems.length, highlightIdx]);

  function activate(item: CommandItem) {
    if (item.kind === "room") {
      onSelectRoom((item.payload as Room).id);
    } else if (item.kind === "message" || item.kind === "task") {
      const p = item.payload as Message | Task;
      if (p?.roomId) onSelectRoom(p.roomId);
    } else if (item.kind === "command") {
      item.action?.();
    }
    onClose();
  }

  function handleKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flatItems.length === 0) return;
      setHighlightIdx((i) => (i + 1) % flatItems.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flatItems.length === 0) return;
      setHighlightIdx((i) => (i - 1 + flatItems.length) % flatItems.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flatItems[highlightIdx];
      if (item) activate(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent
        className="max-w-2xl p-0 gap-0 overflow-hidden"
        onKeyDown={handleKey}
      >
        <DialogTitle className="sr-only">Command Bar</DialogTitle>

        <div className="flex items-center gap-2 px-4 border-b h-12">
          <Search className="h-4 w-4 text-zinc-400 shrink-0" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or run a command…"
            className="h-12 border-0 shadow-none px-0 text-[15px] bg-transparent"
          />
          <kbd className="hidden sm:inline-flex items-center rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 font-mono">
            ⌘K
          </kbd>
        </div>

        <div className="flex items-center gap-1 px-3 py-2 border-b">
          {PILLS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setFilter(p.id)}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                filter === p.id
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-500 hover:text-zinc-700 hover:bg-zinc-50",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="max-h-96 overflow-auto p-1">
          {flatItems.length === 0 ? (
            <div className="text-sm text-zinc-500 text-center py-8">
              {query.trim() ? "No results" : "Start typing to search…"}
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.kind}>
                <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                  {group.label}
                </div>
                {group.entries.map(({ item, idx }) => {
                  const isActive = idx === highlightIdx;
                  const Icon = ICON_MAP[item.icon ?? "Hash"] ?? Hash;
                  const hl = highlightMatch(item.title, query);
                  const rightLabel =
                    item.hint ?? item.kind.toUpperCase();
                  return (
                    <button
                      key={`${item.kind}-${item.id}`}
                      type="button"
                      onClick={() => activate(item)}
                      onMouseEnter={() => setHighlightIdx(idx)}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors",
                        isActive ? "bg-zinc-100" : "hover:bg-zinc-50",
                      )}
                    >
                      <Icon className="h-4 w-4 text-zinc-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-zinc-900 truncate">
                          {hl ? (
                            <>
                              {hl.before}
                              <span className="bg-yellow-100 text-zinc-900 rounded-sm px-0.5">
                                {hl.match}
                              </span>
                              {hl.after}
                            </>
                          ) : (
                            item.title
                          )}
                        </div>
                        {item.subtitle && (
                          <div className="text-xs text-zinc-500 truncate">
                            {item.subtitle}
                          </div>
                        )}
                      </div>
                      <span className="text-[10px] text-zinc-400 uppercase tracking-wide shrink-0">
                        {rightLabel}
                      </span>
                      {isActive && (
                        <CornerDownLeft className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { CommandBar as SearchPalette };
