import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ListTodo, Activity, StickyNote, AlertTriangle, History, Plus, Play, Pause,
  Circle, CheckCircle2, AlertCircle, Clock, Sparkles, ArrowRight, Wrench, Hand,
} from "lucide-react";
import type { Task, Message, Finding, Event, Room, Agent, ActivityEvent } from "@/types";
import { cn, debounce, formatTime, formatRelativeTime } from "@/lib/utils";

type Tab = "live" | "tasks" | "notes" | "findings" | "replay";

type Props = {
  room: Room;
  tasks: Task[];
  messages: Message[];
  findings: Finding[];
  events: Event[];
  activities?: ActivityEvent[];
  agents: Agent[];
  onCreateTask: (title: string) => void;
  onUpdateTask: (id: string, patch: Partial<Task>) => void;
  onDeleteTask: (id: string) => void;
  onSaveNotes: (notes: string) => void;
  onStopAll?: () => void;
};

export function RightPanel({
  room, tasks, messages, findings, events,
  activities = [], agents,
  onCreateTask, onUpdateTask, onDeleteTask, onSaveNotes,
  onStopAll,
}: Props) {
  const [tab, setTab] = useState<Tab>("live");
  const [notes, setNotes] = useState(room.notes ?? "");
  const [notesStatus, setNotesStatus] = useState<"idle" | "saving" | "saved">("idle");

  const debouncedSave = useRef(debounce((value: string) => {
    onSaveNotes(value);
    setNotesStatus("saved");
    setTimeout(() => setNotesStatus("idle"), 2000);
  }, 800)).current;

  useEffect(() => {
    setNotes(room.notes ?? "");
  }, [room.id, room.notes]);

  function handleNotesChange(v: string) {
    setNotes(v);
    setNotesStatus("saving");
    debouncedSave(v);
  }

  const tabs: Array<{ id: Tab; label: string; icon: any; count?: number }> = [
    { id: "live", label: "Live", icon: Activity },
    { id: "tasks", label: "Tasks", icon: ListTodo, count: tasks.length },
    { id: "notes", label: "Notes", icon: StickyNote },
    { id: "findings", label: "Findings", icon: AlertTriangle, count: findings.length },
    { id: "replay", label: "Replay", icon: History, count: events.length },
  ];

  return (
    <aside className="relative w-80 border-l border-zinc-200/80 bg-zinc-50/50 flex shrink-0">
      {/* resize handle stub */}
      <div className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 flex flex-col items-center justify-center gap-0.5 group">
        <span className="h-1 w-1 rounded-full bg-zinc-300 group-hover:bg-zinc-400" />
        <span className="h-1 w-1 rounded-full bg-zinc-300 group-hover:bg-zinc-400" />
        <span className="h-1 w-1 rounded-full bg-zinc-300 group-hover:bg-zinc-400" />
      </div>

      <div className="flex flex-col flex-1 min-w-0">
        {/* tabs */}
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
                    "relative flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-t-md transition-colors shrink-0",
                    active
                      ? "text-zinc-900"
                      : "text-zinc-500 hover:text-zinc-700"
                  )}
                >
                  <Icon className="h-3 w-3" />
                  <span>{t.label}</span>
                  {t.count !== undefined && t.count > 0 && (
                    <span className={cn(
                      "text-[9px] font-semibold rounded-full px-1.5 h-3.5 min-w-3.5 inline-flex items-center justify-center bg-zinc-100 text-zinc-500"
                    )}>
                      {t.count > 99 ? "99+" : t.count}
                    </span>
                  )}
                  {active && (
                    <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-indigo-500" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {tab === "live" && <LiveTab room={room} activities={activities} agents={agents} onStopAll={onStopAll} />}
          {tab === "tasks" && <TasksTab tasks={tasks} onCreate={onCreateTask} onUpdate={onUpdateTask} onDelete={onDeleteTask} />}
          {tab === "notes" && <NotesTab notes={notes} status={notesStatus} onChange={handleNotesChange} />}
          {tab === "findings" && <FindingsTab findings={findings} />}
          {tab === "replay" && <ReplayTab events={events} />}
        </div>
      </div>
    </aside>
  );
}

function LiveTab({ room, activities, agents, onStopAll }: {
  room: Room; activities: ActivityEvent[]; agents: Agent[]; onStopAll?: () => void;
}) {
  const agentMap = new Map(agents.map(a => [a.id, a]));
  // Scope to the current room — App-level activity state includes events from
  // every room and would otherwise leak across rooms.
  const roomActivities = activities.filter(a => a.roomId === room.id);

  // Determine which agents have an outstanding thinking (not yet completed/errored since)
  // by walking the events in chronological order and folding terminal events.
  const outstanding = new Set<string>();
  const thinkingAgents = new Set<string>();
  [...roomActivities]
    .sort((a, b) => a.timestamp - b.timestamp)
    .forEach(e => {
      if (e.kind === "agent.thinking" && e.agentId) {
        thinkingAgents.add(e.agentId);
      } else if ((e.kind === "agent.completed" || e.kind === "agent.error") && e.agentId) {
        thinkingAgents.delete(e.agentId);
      }
    });
  thinkingAgents.forEach(id => outstanding.add(id));

  // "Has thinking" is derived from the live outstanding set so the Stop button
  // disappears as soon as the last running agent finishes/errors.
  const hasThinking = outstanding.size > 0;

  // newest first for display
  const ordered = [...roomActivities].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="flex flex-col h-full">
      {hasThinking && (
        <div className="sticky top-0 z-10 px-3 py-2 border-b border-zinc-200/80 bg-white/95 backdrop-blur shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onStopAll?.()}
            className="w-full h-7 text-[11px] gap-1.5 border-red-200 bg-red-50/50 text-red-700 hover:bg-red-100 hover:text-red-800"
          >
            <Pause className="h-3 w-3" />
            Stop all running agents
          </Button>
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-0.5">
          {ordered.length === 0 ? (
            <LiveEmpty />
          ) : (
            ordered.map(e => (
              <ActivityRow
                key={e.id}
                event={e}
                agent={e.agentId ? agentMap.get(e.agentId) : undefined}
                isOutstanding={!!(e.agentId && outstanding.has(e.agentId))}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function LiveEmpty() {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-16">
      <div className="relative mb-3">
        <div className="h-10 w-10 rounded-full bg-gradient-to-br from-indigo-50 to-violet-100 flex items-center justify-center border border-indigo-100/80">
          <Sparkles className="h-4 w-4 text-indigo-500" />
        </div>
        <span className="absolute -top-1 -right-1 text-base leading-none">✨</span>
      </div>
      <h3 className="text-[12.5px] font-semibold text-zinc-800 mb-1">Awaiting first signal</h3>
      <p className="text-[11.5px] text-zinc-500 leading-relaxed max-w-[220px]">
        Agent activity will appear here as the team works. Toggle Review to get started.
      </p>
    </div>
  );
}

function ActivityRow({ event, agent, isOutstanding }: {
  event: ActivityEvent; agent?: Agent; isOutstanding: boolean;
}) {
  const isError = event.kind === "agent.error";
  const isCompleted = event.kind === "agent.completed";
  const isActive = isOutstanding && event.kind === "agent.thinking";

  const { Icon, primary, secondary } = describeEvent(event, agent);

  return (
    <div className={cn(
      "group relative flex gap-2 px-2 py-1.5 rounded-md border border-transparent transition-colors",
      isActive && "bg-indigo-50/40 border-indigo-200/70",
      isActive && "before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-indigo-500 before:animate-pulse",
      isError && "bg-red-50/40 border-red-200/70",
      !isActive && !isError && "hover:bg-white hover:border-zinc-200/80"
    )}>
      {/* avatar dot or status icon */}
      <div className="shrink-0 mt-0.5">
        {agent ? (
          <span
            className="block h-1.5 w-1.5 rounded-full ring-2 ring-white shadow-sm"
            style={{ backgroundColor: agent.color }}
            title={agent.name}
          />
        ) : (
          <span className={cn(
            "h-3.5 w-3.5 rounded-full flex items-center justify-center",
            isError ? "bg-red-100 text-red-600" :
            isCompleted ? "bg-emerald-100 text-emerald-600" :
            "bg-zinc-100 text-zinc-500"
          )}>
            <Icon className="h-2.5 w-2.5" />
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className={cn(
            "text-[12px] leading-snug font-medium truncate",
            isError ? "text-red-800" :
            isCompleted ? "text-zinc-500" :
            "text-zinc-800"
          )}>
            {primary}
          </div>
          <div className="text-[10px] text-zinc-400 shrink-0 tabular-nums">
            {formatRelativeTime(event.timestamp)}
          </div>
        </div>
        {secondary && (
          <p className={cn(
            "text-[11.5px] mt-0.5 leading-snug line-clamp-2",
            isError ? "text-red-700/80" :
            isCompleted ? "text-zinc-400" :
            "text-zinc-500"
          )}>
            {secondary}
          </p>
        )}
      </div>
    </div>
  );
}

function describeEvent(e: ActivityEvent, agent?: Agent): { Icon: any; primary: string; secondary?: string } {
  const name = agent?.name ?? "Agent";
  const detail = e.message ?? "";
  switch (e.kind) {
    case "agent.thinking":
      return { Icon: Sparkles, primary: `${name} is thinking`, secondary: detail };
    case "agent.tool_call":
      return { Icon: Wrench, primary: `${name} called tool ${e.meta?.tool ?? "unknown"}`, secondary: detail };
    case "agent.handoff":
      return { Icon: Hand, primary: `${name} handed off`, secondary: detail || "Passing context to another agent" };
    case "agent.completed":
      return { Icon: CheckCircle2, primary: `${name} completed`, secondary: detail };
    case "agent.error":
      return { Icon: AlertCircle, primary: `${name} errored`, secondary: detail };
    case "task.created":
      return { Icon: ListTodo, primary: `Task created`, secondary: detail };
    case "task.updated":
      return { Icon: ListTodo, primary: `Task updated`, secondary: detail };
    case "self_talk.tick":
      return { Icon: ArrowRight, primary: `Self-talk tick`, secondary: detail };
    default:
      return { Icon: Activity, primary: e.kind, secondary: detail };
  }
}

function TasksTab({ tasks, onCreate, onUpdate, onDelete }: {
  tasks: Task[]; onCreate: (t: string) => void; onUpdate: (id: string, p: Partial<Task>) => void; onDelete: (id: string) => void;
}) {
  const [newTitle, setNewTitle] = useState("");
  const STATUS_META: Record<string, { icon: any; color: string; label: string }> = {
    doing: { icon: Clock, color: "text-amber-600 bg-amber-50", label: "Doing" },
    todo: { icon: Circle, color: "text-zinc-500 bg-zinc-100", label: "Todo" },
    blocked: { icon: AlertCircle, color: "text-red-600 bg-red-50", label: "Blocked" },
    done: { icon: CheckCircle2, color: "text-emerald-600 bg-emerald-50", label: "Done" },
  };
  const order = ["doing", "todo", "blocked", "done"];
  const sorted = [...tasks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-zinc-200/80 bg-white">
        <div className="flex gap-1.5">
          <Input
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            placeholder="New task…"
            className="h-8 text-[12px]"
            onKeyDown={e => { if (e.key === "Enter" && newTitle.trim()) { onCreate(newTitle); setNewTitle(""); } }}
          />
          <Button size="icon" className="h-8 w-8 shrink-0 bg-indigo-600 hover:bg-indigo-700"
            onClick={() => { if (newTitle.trim()) { onCreate(newTitle); setNewTitle(""); } }}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {sorted.length === 0 && <TasksEmpty />}
          {sorted.map(t => {
            const meta = STATUS_META[t.status] ?? STATUS_META.todo;
            const Icon = meta.icon;
            return (
              <div key={t.id} className="group flex items-start gap-2 px-2 py-1.5 rounded-md hover:bg-white border border-transparent hover:border-zinc-200/80 hover:shadow-sm transition-all">
                <button
                  onClick={() => onUpdate(t.id, { status: t.status === "done" ? "todo" : "done" })}
                  className={cn("h-4 w-4 rounded-full border-2 mt-0.5 shrink-0 transition-colors flex items-center justify-center",
                    t.status === "done" ? "bg-emerald-500 border-emerald-500 text-white" : "border-zinc-300 hover:border-emerald-400"
                  )}
                >
                  {t.status === "done" && <CheckCircle2 className="h-3 w-3" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className={cn("text-[12.5px] leading-snug", t.status === "done" && "line-through text-zinc-400")}>
                    {t.title}
                  </div>
                  <select
                    value={t.status}
                    onChange={e => onUpdate(t.id, { status: e.target.value as any })}
                    className="text-[10px] mt-1 bg-transparent border-0 text-zinc-500 focus:outline-none cursor-pointer"
                  >
                    {Object.entries(STATUS_META).map(([k, m]) => (
                      <option key={k} value={k}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <Button variant="ghost" size="icon" className="h-5 w-5 opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-500"
                  onClick={() => onDelete(t.id)}>
                  ×
                </Button>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function TasksEmpty() {
  return (
    <div className="flex flex-col gap-3 py-6">
      <p className="text-[11.5px] text-zinc-500 text-center leading-relaxed px-4">
        Tasks created here will appear as cards the team can claim.
      </p>
      <div className="mx-3 rounded-md border border-dashed border-zinc-200/80 bg-white/60 p-2.5">
        <div className="flex items-start gap-2">
          <span className="h-4 w-4 rounded-full border-2 border-zinc-300 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] text-zinc-400 leading-snug">
              Wire up the auth flow
            </div>
            <div className="flex items-center gap-1 mt-1">
              <Circle className="h-2.5 w-2.5 text-zinc-400" />
              <span className="text-[10px] text-zinc-400">Todo</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function NotesTab({ notes, status, onChange }: {
  notes: string; status: "idle" | "saving" | "saved"; onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-3">
        <Textarea
          value={notes}
          onChange={e => onChange(e.target.value)}
          placeholder="Room notes — scratchpad, decisions, todos…"
          className="h-full resize-none text-[13px] leading-relaxed border-zinc-200/80 bg-white"
        />
      </div>
      <div className="px-3 py-2 border-t border-zinc-200/80 bg-white flex items-center justify-between">
        <span className="text-[10px] text-zinc-400">
          {notes.length} chars
        </span>
        <span className={cn(
          "text-[10px] inline-flex items-center gap-1",
          status === "saving" ? "text-amber-600" :
          status === "saved" ? "text-emerald-600" : "text-zinc-400"
        )}>
          {status === "saving" ? (<><span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" /> Saving…</>) :
           status === "saved" ? (<><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Saved</>) :
           "Auto-saves"}
        </span>
      </div>
    </div>
  );
}

function FindingsTab({ findings }: { findings: Finding[] }) {
  const groups = {
    critical: findings.filter(f => f.severity === "critical"),
    major: findings.filter(f => f.severity === "major"),
    minor: findings.filter(f => f.severity === "minor"),
  };
  const SEV: any = {
    critical: { bar: "bg-red-500", label: "Critical" },
    major: { bar: "bg-amber-500", label: "Major" },
    minor: { bar: "bg-sky-500", label: "Minor" },
  };
  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-3">
        {(["critical", "major", "minor"] as const).map(sev => (
          <div key={sev}>
            <h4 className={cn("text-[10px] font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1.5",
              sev === "critical" ? "text-red-600" :
              sev === "major" ? "text-amber-600" : "text-sky-600"
            )}>
              <span className={cn("h-1.5 w-1.5 rounded-full", SEV[sev].bar)} />
              {SEV[sev].label} ({groups[sev].length})
            </h4>
            {groups[sev].map((f, i) => (
              <div key={i} className="relative pl-3 pr-2 py-2 mb-1 bg-white border border-zinc-200/80 rounded-md overflow-hidden">
                <span className={cn("absolute left-0 top-0 bottom-0 w-0.5", SEV[sev].bar)} />
                <div className="text-[12.5px] font-medium text-zinc-900">{f.title}</div>
                {f.location && <div className="text-[10.5px] font-mono text-zinc-500 mt-0.5">{f.location}</div>}
                {f.suggested && <div className="text-[11px] text-emerald-700 mt-1">→ {f.suggested}</div>}
              </div>
            ))}
          </div>
        ))}
        {findings.length === 0 && (
          <div className="text-[12px] text-zinc-400 text-center py-8">No findings</div>
        )}
      </div>
    </ScrollArea>
  );
}

function ReplayTab({ events }: { events: Event[] }) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [idx, setIdx] = useState(events.length);

  useEffect(() => { setIdx(events.length); }, [events.length]);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setIdx(i => Math.min(events.length, i + 1)), 1000 / speed);
    return () => clearInterval(t);
  }, [playing, speed, events.length]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-zinc-200/80 bg-white flex items-center gap-2">
        <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setPlaying(p => !p)}>
          {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        </Button>
        <select value={speed} onChange={e => setSpeed(parseInt(e.target.value))}
          className="text-[11px] h-7 px-2 bg-white border border-zinc-200 rounded">
          <option value="1">1x</option>
          <option value="2">2x</option>
          <option value="5">5x</option>
          <option value="10">10x</option>
        </select>
        <span className="text-[10px] text-zinc-500 font-mono">{idx}/{events.length}</span>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-0.5">
          {events.slice(0, idx).map(e => (
            <div key={e.id} className="flex gap-2 px-2 py-1 rounded hover:bg-white border border-transparent hover:border-zinc-200/80">
              <span className="text-[10px] text-zinc-400 shrink-0 mt-0.5">{formatRelativeTime(e.timestamp)}</span>
              <code className="text-[11px] text-zinc-700 font-mono truncate">{e.type}</code>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}