import { useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Activity, Users, Brain, Wrench, Pause, Sparkles, CheckCircle2,
  AlertCircle, ArrowRight, Hand, Circle, Zap, KanbanSquare, Plus,
  ChevronRight, Trash2, ListTodo, PlayCircle, Lock, X,
} from "lucide-react";
import type { ActivityEvent, Agent, Room, MemoryEntry, Task } from "@/types";
import { cn, formatRelativeTime } from "@/lib/utils";

type Tab = "live" | "tasks" | "agents" | "memory" | "tools";

type Props = {
  room: Room;
  activities?: ActivityEvent[];
  agents: Agent[];
  memoryEntries: MemoryEntry[];
  tasks: Task[];
  onCreateTask?: (title: string) => void;
  onUpdateTask?: (id: string, patch: Partial<Task>) => void;
  onDeleteTask?: (id: string) => void;
  onStopAll?: () => void;
};

export function RightPanel({
  room, activities = [], agents, memoryEntries,
  tasks = [], onCreateTask, onUpdateTask, onDeleteTask, onStopAll,
}: Props) {
  const [tab, setTab] = useState<Tab>("live");
  const [widthPx, setWidthPx] = useState(320);
  const widthRef = { current: widthPx };
  widthRef.current = widthPx;

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      setWidthPx(Math.max(240, Math.min(600, startWidth + delta)));
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

  // noise badge on Live tab so you know there's motion even in another tab
  const liveCount = useMemo(
    () => activities.filter(a => a.roomId === room.id).length,
    [activities, room.id]
  );
  const openTasks = tasks.filter(t => t.status !== "done").length;

  const tabs: Array<{ id: Tab; label: string; icon: any; badge?: number }> = [
    { id: "live", label: "Live", icon: Activity, badge: liveCount || undefined },
    { id: "tasks", label: "Tasks", icon: KanbanSquare, badge: openTasks || undefined },
    { id: "agents", label: "Agents", icon: Users },
    { id: "memory", label: "Memory", icon: Brain },
    { id: "tools", label: "Tools", icon: Wrench },
  ];

  return (
    <aside className="relative border-l border-zinc-200/80 bg-zinc-50/50 flex shrink-0" style={{ width: widthPx }}>
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 flex flex-col items-center justify-center gap-0.5 group"
        onMouseDown={handleResizeMouseDown}
      >
        <span className="h-1 w-1 rounded-full bg-zinc-300 group-hover:bg-zinc-400" />
        <span className="h-1 w-1 rounded-full bg-zinc-300 group-hover:bg-zinc-400" />
        <span className="h-1 w-1 rounded-full bg-zinc-300 group-hover:bg-zinc-400" />
      </div>

      <div className="flex flex-col flex-1 min-w-0">
        <div className="border-b border-zinc-200/80 bg-white px-2 pt-2 shrink-0">
          <div className="flex items-center gap-0 overflow-x-auto">
            {tabs.map(t => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "relative flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium rounded-t-md transition-colors shrink-0",
                    active ? "text-zinc-900" : "text-zinc-500 hover:text-zinc-700"
                  )}
                >
                  <Icon className="h-3 w-3" />
                  <span>{t.label}</span>
                  {!active && t.badge != null && (
                    <span className="ml-0.5 min-w-[14px] px-1 h-[14px] rounded-full bg-zinc-100 text-zinc-500 text-[9px] font-semibold leading-[14px] text-center">
                      {t.badge > 99 ? "99+" : t.badge}
                    </span>
                  )}
                  {active && <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-indigo-500" />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {tab === "live" && <LiveTab room={room} activities={activities} agents={agents} onStopAll={onStopAll} />}
          {tab === "tasks" && (
            <TasksTab
              tasks={tasks}
              agents={agents}
              onCreateTask={onCreateTask}
              onUpdateTask={onUpdateTask}
              onDeleteTask={onDeleteTask}
            />
          )}
          {tab === "agents" && <AgentsTab room={room} agents={agents} activities={activities} />}
          {tab === "memory" && <MemoryTab entries={memoryEntries} />}
          {tab === "tools" && <ToolsTab activities={activities} room={room} />}
        </div>
      </div>
    </aside>
  );
}

/* ---------- Tasks Tab ---------- */

const STATUS_ORDER: Array<Task["status"]> = ["todo", "doing", "blocked", "done"];
const STATUS_META: Record<Task["status"], { label: string; icon: any; badge: string }> = {
  todo: { label: "Todo", icon: ListTodo, badge: "bg-zinc-100 text-zinc-600 border-zinc-200" },
  doing: { label: "Doing", icon: PlayCircle, badge: "bg-sky-50 text-sky-700 border-sky-200" },
  blocked: { label: "Blocked", icon: Lock, badge: "bg-red-50 text-red-700 border-red-200" },
  done: { label: "Done", icon: CheckCircle2, badge: "bg-emerald-50 text-emerald-700 border-emerald-200" },
};

function TasksTab({ tasks, agents, onCreateTask, onUpdateTask, onDeleteTask }: {
  tasks: Task[];
  agents: Agent[];
  onCreateTask?: (title: string) => void;
  onUpdateTask?: (id: string, patch: Partial<Task>) => void;
  onDeleteTask?: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const agentMap = new Map(agents.map(a => [a.id, a]));

  const submit = () => {
    const title = draft.trim();
    if (!title || !onCreateTask) return;
    onCreateTask(title);
    setDraft("");
  };

  const grouped = useMemo(() => {
    const g = new Map<Task["status"], Task[]>();
    for (const s of STATUS_ORDER) g.set(s, []);
    for (const t of tasks) (g.get(t.status ?? "todo") ?? []).push(t);
    for (const s of STATUS_ORDER) g.get(s)!.sort((a, b) => a.createdAt - b.createdAt);
    return g;
  }, [tasks]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b border-zinc-200/60 bg-white shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-1 bg-white border border-zinc-200 rounded-md focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100">
          <Plus className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
            }}
            placeholder="Add a task…"
            className="flex-1 bg-transparent text-[12px] outline-none placeholder:text-zinc-400"
          />
          {draft.trim() && (
            <button
              onClick={submit}
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-600 text-white hover:bg-indigo-700"
            >
              Add
            </button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-3">
          {tasks.length === 0 ? (
            <Empty icon={KanbanSquare} title="No tasks yet" desc="Create a task above or ask an agent to add one." />
          ) : (
            STATUS_ORDER.map(status => {
              const list = grouped.get(status)!;
              if (list.length === 0) return null;
              const meta = STATUS_META[status];
              const Icon = meta.icon;
              return (
                <div key={status}>
                  <div className="flex items-center gap-1.5 px-1 mb-1">
                    <Icon className="h-3 w-3 text-zinc-400" />
                    <span className="text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500">{meta.label}</span>
                    <span className="text-[10px] text-zinc-400">{list.length}</span>
                  </div>
                  <div className="space-y-1">
                    {list.map(t => {
                      const assignee = t.assigneeId ? agentMap.get(t.assigneeId) : undefined;
                      const nextStatus = STATUS_ORDER[(STATUS_ORDER.indexOf(t.status) + 1) % STATUS_ORDER.length];
                      return (
                        <div
                          key={t.id}
                          className={cn(
                            "group relative flex items-start gap-2 pl-2 pr-1 py-1.5 rounded-lg border bg-white transition-colors",
                            status === "done" ? "border-zinc-200/60 opacity-70" : "border-zinc-200/80 hover:border-indigo-200"
                          )}
                        >
                          <button
                            onClick={() => onUpdateTask?.(t.id, { status: nextStatus })}
                            title={`Move to ${STATUS_META[nextStatus].label}`}
                            className="mt-0.5 shrink-0"
                          >
                            {status === "done" ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                            ) : (
                              <Circle className="h-3.5 w-3.5 text-zinc-300 hover:text-indigo-400 transition-colors" />
                            )}
                          </button>
                          <div className="min-w-0 flex-1">
                            <p className={cn("text-[12px] leading-snug text-zinc-800 break-words", status === "done" && "line-through decoration-zinc-400")}>
                              {t.title}
                            </p>
                            {assignee && (
                              <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-zinc-400">
                                <span className="h-1.5 w-1.5 rounded-full" style={{ background: assignee.color }} />
                                @{assignee.name}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            {status !== "done" && (
                              <button
                                onClick={() => onUpdateTask?.(t.id, { status: nextStatus })}
                                title={`→ ${STATUS_META[nextStatus].label}`}
                                className="h-5 w-5 rounded flex items-center justify-center text-zinc-400 hover:text-indigo-600 hover:bg-indigo-50"
                              >
                                <ChevronRight className="h-3 w-3" />
                              </button>
                            )}
                            <button
                              onClick={() => onDeleteTask?.(t.id)}
                              title="Delete task"
                              className="h-5 w-5 rounded flex items-center justify-center text-zinc-400 hover:text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/* ---------- Live Tab ---------- */

type GroupedActivity =
  | { type: "single"; event: ActivityEvent }
  | { type: "tool-run"; events: ActivityEvent[] };

/**
 * Collapse consecutive identical tool calls (same agent + same tool) into a
 * single expandable run row so polling-heavy agents don't flood the feed.
 */
function groupActivities(orderedDesc: ActivityEvent[]): GroupedActivity[] {
  const out: GroupedActivity[] = [];
  let i = 0;
  while (i < orderedDesc.length) {
    const e = orderedDesc[i];
    if (e.kind === "agent.tool_call") {
      let j = i + 1;
      while (
        j < orderedDesc.length &&
        orderedDesc[j].kind === "agent.tool_call" &&
        orderedDesc[j].agentId === e.agentId &&
        String(orderedDesc[j].meta?.tool) === String(e.meta?.tool)
      ) j++;
      if (j - i > 2) {
        out.push({ type: "tool-run", events: orderedDesc.slice(i, j) });
        i = j;
        continue;
      }
    }
    out.push({ type: "single", event: e });
    i++;
  }
  return out;
}

function LiveTab({ room, activities, agents, onStopAll }: {
  room: Room; activities: ActivityEvent[]; agents: Agent[]; onStopAll?: () => void;
}) {
  const agentMap = new Map(agents.map(a => [a.id, a]));
  const roomActs = activities.filter(a => a.roomId === room.id);

  const outstanding = new Set<string>();
  const thinking = new Set<string>();
  [...roomActs].sort((a, b) => a.timestamp - b.timestamp).forEach(e => {
    if (e.kind === "agent.thinking" && e.agentId) thinking.add(e.agentId);
    else if ((e.kind === "agent.completed" || e.kind === "agent.error") && e.agentId) thinking.delete(e.agentId);
  });
  thinking.forEach(id => outstanding.add(id));

  const ordered = [...roomActs].sort((a, b) => b.timestamp - a.timestamp);
  const grouped = useMemo(() => groupActivities(ordered), [ordered]);

  return (
    <div className="flex flex-col h-full">
      {outstanding.size > 0 && (
        <div className="sticky top-0 z-10 px-3 py-2 border-b border-zinc-200/80 bg-white/95 backdrop-blur shrink-0">
          <Button variant="outline" size="sm" onClick={() => onStopAll?.()}
            className="w-full h-7 text-[11px] gap-1.5 border-red-200 bg-red-50/50 text-red-700 hover:bg-red-100 hover:text-red-800">
            <Pause className="h-3 w-3" />Stop all
          </Button>
        </div>
      )}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-0.5">
          {grouped.length === 0 ? (
            <Empty icon={Sparkles} title="Awaiting first signal" desc="Agent activity appears here as the team works." />
          ) : (
            grouped.map(g =>
              g.type === "single" ? (
                <ActivityRow key={g.event.id} event={g.event}
                  agent={g.event.agentId ? agentMap.get(g.event.agentId) : undefined}
                  isThinking={!!(g.event.agentId && outstanding.has(g.event.agentId))} />
              ) : (
                <ToolRunRow key={g.events[0].id} events={g.events}
                  agent={g.events[0].agentId ? agentMap.get(g.events[0].agentId) : undefined} />
              )
            )
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ToolRunRow({ events, agent }: { events: ActivityEvent[]; agent?: Agent }) {
  const [open, setOpen] = useState(false);
  const name = agent?.name ?? "Agent";
  const tool = String(events[0].meta?.tool ?? "tool");
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={cn(
          "group relative flex gap-2 px-2 py-1.5 rounded-md border border-transparent transition-colors w-full text-left",
          open ? "bg-white border-zinc-200/80" : "hover:bg-white hover:border-zinc-200/80"
        )}
      >
        <div className="shrink-0 mt-0.5">
          {agent ? (
            <span className="block h-1.5 w-1.5 rounded-full ring-2 ring-white shadow-sm" style={{ backgroundColor: agent.color }} title={name} />
          ) : (
            <span className="h-3.5 w-3.5 rounded-full bg-zinc-100 text-zinc-500 flex items-center justify-center">
              <Wrench className="h-2.5 w-2.5" />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 flex items-baseline justify-between gap-2">
          <span className="text-[12px] leading-snug font-medium text-zinc-700 truncate">
            {name} → <code className="font-mono text-[11px]">{tool}</code>
            <span className="ml-1.5 text-[10px] font-semibold text-zinc-400">×{events.length}</span>
          </span>
          <span className="text-[10px] text-zinc-400 shrink-0 tabular-nums">{formatRelativeTime(events[0].timestamp)}</span>
        </div>
      </button>
      {open && (
        <div className="ml-6 mb-1 animate-slide-down">
          {events.slice(0, 20).map(ev => (
            <div key={ev.id} className="flex items-center justify-between pl-2 pr-1 py-0.5">
              <span className="text-[10.5px] text-zinc-500 flex items-center gap-1">
                <ChevronRight className="h-2.5 w-2.5 text-zinc-300" />
                {ev.message ?? tool}
              </span>
              <span className="text-[9.5px] text-zinc-300 tabular-nums">{formatRelativeTime(ev.timestamp)}</span>
            </div>
          ))}
          {events.length > 20 && (
            <p className="pl-2 text-[9.5px] text-zinc-400">…and {events.length - 20} more</p>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ event, agent, isThinking }: { event: ActivityEvent; agent?: Agent; isThinking: boolean }) {
  const isErr = event.kind === "agent.error";
  const isDone = event.kind === "agent.completed";
  const isActive = isThinking && event.kind === "agent.thinking";
  const { Icon, primary, secondary } = describeEvent(event, agent);

  return (
    <div className={cn(
      "group relative flex gap-2 px-2 py-1.5 rounded-md border border-transparent transition-colors",
      isActive && "bg-indigo-50/40 border-indigo-200/70 before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-indigo-500 before:animate-pulse",
      isErr && "bg-red-50/40 border-red-200/70",
      !isActive && !isErr && "hover:bg-white hover:border-zinc-200/80"
    )}>
      <div className="shrink-0 mt-0.5">
        {agent ? (
          <span className="block h-1.5 w-1.5 rounded-full ring-2 ring-white shadow-sm" style={{ backgroundColor: agent.color }} title={agent.name} />
        ) : (
          <span className={cn("h-3.5 w-3.5 rounded-full flex items-center justify-center",
            isErr ? "bg-red-100 text-red-600" : isDone ? "bg-emerald-100 text-emerald-600" : "bg-zinc-100 text-zinc-500")}>
            <Icon className="h-2.5 w-2.5" />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className={cn("text-[12px] leading-snug font-medium truncate",
            isErr ? "text-red-800" : isDone ? "text-zinc-500" : "text-zinc-800")}>
            {primary}
          </div>
          <div className="text-[10px] text-zinc-400 shrink-0 tabular-nums">{formatRelativeTime(event.timestamp)}</div>
        </div>
        {secondary && <p className={cn("text-[11.5px] mt-0.5 leading-snug line-clamp-2",
          isErr ? "text-red-700/80" : isDone ? "text-zinc-400" : "text-zinc-500")}>{secondary}</p>}
      </div>
    </div>
  );
}

function describeEvent(e: ActivityEvent, agent?: Agent): { Icon: any; primary: string; secondary?: string } {
  const name = agent?.name ?? "Agent";
  const detail = e.message ?? "";
  switch (e.kind) {
    case "agent.thinking": return { Icon: Sparkles, primary: `${name} thinking…`, secondary: detail };
    case "agent.tool_call": return { Icon: Wrench, primary: `${name} → ${e.meta?.tool ?? "tool"}`, secondary: detail };
    case "agent.handoff": return { Icon: Hand, primary: `${name} handed off`, secondary: detail };
    case "agent.completed": return { Icon: CheckCircle2, primary: `${name} done`, secondary: detail };
    case "agent.error": return { Icon: AlertCircle, primary: `${name} errored`, secondary: detail };
    default: return { Icon: Activity, primary: e.kind, secondary: detail };
  }
}

/* ---------- Agents Tab ---------- */

function AgentsTab({ room, agents, activities }: { room: Room; agents: Agent[]; activities: ActivityEvent[] }) {
  const roomActivities = activities.filter(a => a.roomId === room.id);
  const thinkingNow = new Set<string>();
  [...roomActivities].sort((a, b) => a.timestamp - b.timestamp).forEach(e => {
    if (e.kind === "agent.thinking" && e.agentId) thinkingNow.add(e.agentId);
    else if ((e.kind === "agent.completed" || e.kind === "agent.error") && e.agentId) thinkingNow.delete(e.agentId);
  });

  const roster = agents.filter(a => room.agentIds.includes(a.id));
  // Sort: thinking first, then online, then others
  roster.sort((a, b) => {
    const aThinking = thinkingNow.has(a.id) ? 0 : 1;
    const bThinking = thinkingNow.has(b.id) ? 0 : 1;
    if (aThinking !== bThinking) return aThinking - bThinking;
    return a.name.localeCompare(b.name);
  });

  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-2">
        {roster.length === 0 ? (
          <Empty icon={Users} title="No agents" desc="Agents assigned to this room appear here." />
        ) : (
          roster.map(a => {
            const active = thinkingNow.has(a.id);
            return (
              <div key={a.id} className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors",
                active ? "bg-indigo-50/50 border-indigo-200/70" : "bg-white border-zinc-200/80"
              )}>
                <div className="relative">
                  <div className="h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold text-white shadow-sm"
                    style={{ backgroundColor: a.color }}>
                    {a.name.charAt(0)}
                  </div>
                  {active && (
                    <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-indigo-500 ring-2 ring-white animate-pulse" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-zinc-800">{a.name}</div>
                  <div className="text-[11px] text-zinc-500 flex items-center gap-1">
                    <span className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      active ? "bg-indigo-500" : a.status === "online" ? "bg-emerald-500" :
                      a.status === "idle" ? "bg-amber-400" : "bg-zinc-300"
                    )} />
                    {active ? "thinking" : a.status}
                  </div>
                </div>
                {active && <Zap className="h-3 w-3 text-indigo-500 animate-pulse shrink-0" />}
              </div>
            );
          })
        )}
      </div>
    </ScrollArea>
  );
}

/* ---------- Memory Tab ---------- */

function MemoryTab({ entries }: { entries: MemoryEntry[] }) {
  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-2">
        {entries.length === 0 ? (
          <Empty icon={Brain} title="No memories" desc="Agent memories for this room appear here as they form." />
        ) : (
          entries.map(m => (
            <div key={m.memoryId} className="px-3 py-2 rounded-lg bg-white border border-zinc-200/80 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-zinc-800">{m.title}</span>
                <span className={cn(
                  "text-[9px] font-medium uppercase px-1.5 py-0.5 rounded-full",
                  m.confidence >= 0.7 ? "bg-emerald-50 text-emerald-700" :
                  m.confidence >= 0.4 ? "bg-amber-50 text-amber-700" :
                  "bg-zinc-100 text-zinc-500"
                )}>
                  {m.category}
                </span>
              </div>
              <p className="text-[11.5px] text-zinc-600 leading-snug">{m.content}{m.contentTruncated && "…"}</p>
              <div className="flex items-center gap-2 text-[10px] text-zinc-400">
                <span>{m.source}</span>
                {m.tags.length > 0 && (
                  <div className="flex gap-1">
                    {m.tags.slice(0, 3).map(t => (
                      <span key={t} className="bg-zinc-100 px-1 rounded">{t}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </ScrollArea>
  );
}

/* ---------- Tools Tab ---------- */

function ToolsTab({ activities, room }: { activities: ActivityEvent[]; room: Room }) {
  const toolCalls = activities
    .filter(a => a.roomId === room.id && a.kind === "agent.tool_call")
    .sort((a, b) => b.timestamp - a.timestamp);

  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-1">
        {toolCalls.length === 0 ? (
          <Empty icon={Wrench} title="No tools yet" desc="Tool calls made by agents appear here." />
        ) : (
          toolCalls.map(tc => (
            <div key={tc.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white border border-transparent hover:border-zinc-200/80 transition-colors">
              <Wrench className="h-3 w-3 text-zinc-400 shrink-0" />
              <code className="text-[11px] text-zinc-700 font-mono truncate flex-1">{String(tc.meta?.tool ?? "unknown")}</code>
              <span className="text-[10px] text-zinc-400 shrink-0 tabular-nums">{formatRelativeTime(tc.timestamp)}</span>
            </div>
          ))
        )}
      </div>
    </ScrollArea>
  );
}

/* ---------- Shared ---------- */

function Empty({ icon: Icon, title, desc }: { icon: any; title: string; desc: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-16">
      <div className="h-10 w-10 rounded-full bg-gradient-to-br from-indigo-50 to-violet-100 flex items-center justify-center border border-indigo-100/80 mb-3">
        <Icon className="h-4 w-4 text-indigo-500" />
      </div>
      <h3 className="text-[12.5px] font-semibold text-zinc-800 mb-1">{title}</h3>
      <p className="text-[11.5px] text-zinc-500 leading-relaxed max-w-[220px]">{desc}</p>
    </div>
  );
}