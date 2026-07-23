import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { CreateRoomDialog } from "@/components/CreateRoomDialog";
import { RoomSettingsDialog } from "@/components/RoomSettingsDialog";
import { TaskEditDialog } from "@/components/TaskEditDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { ws } from "@/lib/ws";
import { atchDebug } from "@/lib/atch-debug";
import type {
  Agent, Message, Room, Project, Task, Finding, Event, ServerEvent, ActivityEvent, ActivityKind,
} from "@/types";
import type { WsStatus } from "@/lib/ws";
import { Toaster, toast } from "@/components/ui/toast-stub";

/* ---------- helpers ---------- */

const ACTIVITY_KINDS: ActivityKind[] = [
  "agent.thinking",
  "agent.tool_call",
  "agent.handoff",
  "agent.completed",
  "agent.error",
  "task.created",
  "task.updated",
  "finding.raised",
  "escalation",
  "self_talk.tick",
];

const MAX_ACTIVITY = 200;

function asActivityKind(s: string): ActivityKind | null {
  return (ACTIVITY_KINDS as string[]).includes(s) ? (s as ActivityKind) : null;
}

export default function App() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [currentRoomId, setCurrentRoomId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [findings] = useState<Finding[]>([]);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [streamingAgentId, setStreamingAgentId] = useState<string | undefined>();
  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingTask] = useState<Task | undefined>();
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; description?: string; destructive?: boolean; onConfirm: () => void } | null>(null);
  const [reviewResult, setReviewResult] = useState<{ findings: Finding[]; summary: string } | null>(null);

  const currentRoom = useMemo(() => rooms.find(r => r.id === currentRoomId), [rooms, currentRoomId]);
  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  const streamingAgent = streamingAgentId ? agentMap.get(streamingAgentId) ?? null : null;

  // stable ref for activity appender (avoid re-binding ws handler)
  const pushActivity = useRef((ev: Omit<ActivityEvent, "id" | "timestamp">) => {
    setActivities(curr => {
      const next: ActivityEvent = {
        id: `${ev.kind}-${ev.agentId ?? "x"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        ...ev,
      };
      const updated = [next, ...curr];
      return updated.slice(0, MAX_ACTIVITY);
    });
  }).current;

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rs, ps, ags] = await Promise.all([api.listRooms(), api.listProjects(), api.listAgents()]);
        if (cancelled) return;
        setRooms(rs);
        setProjects(ps);
        setAgents(ags);
        if (rs.length > 0) setCurrentRoomId(rs[0].id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        atchDebug.error("app", "initial load failed", { error: msg });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // WebSocket connect
  useEffect(() => {
    ws.onStatus(setWsStatus);
    ws.connect();
    return () => ws.disconnect();
  }, []);

  // Load room data when room changes
  useEffect(() => {
    if (!currentRoomId) return;
    let cancelled = false;
    (async () => {
      try {
        const [msgs, tks, evs] = await Promise.all([
          api.listMessages(currentRoomId),
          api.listTasks(currentRoomId),
          api.listRoomEvents(currentRoomId),
        ]);
        if (cancelled) return;
        setMessages(msgs);
        setTasks(tks);
        setEvents(evs);
      } catch (err) {
        atchDebug.warn("app", "room load failed", { roomId: currentRoomId, error: String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [currentRoomId]);

  // WS event handler — extended for live activity stream
  useEffect(() => {
    const unsub = ws.on((event: ServerEvent, payload: any) => {
      switch (event) {
        case "message.created": {
          const msg = payload as Message;
          if (msg.roomId === currentRoomId) {
            setMessages(curr => [...curr, msg]);
          }
          break;
        }
        case "task.created": {
          const t = payload as Task;
          if (t.roomId === currentRoomId) setTasks(curr => [t, ...curr]);
          pushActivity({ roomId: t.roomId, kind: "task.created", message: `Task created: ${t.title}` });
          break;
        }
        case "task.updated": {
          const t = payload as Task;
          if (t.roomId === currentRoomId) {
            setTasks(curr => curr.map(x => x.id === t.id ? t : x));
          }
          pushActivity({ roomId: t.roomId, kind: "task.updated", message: `Task ${t.status}: ${t.title}` });
          break;
        }
        case "task.deleted": {
          const { id } = payload as { id: string };
          setTasks(curr => curr.filter(x => x.id !== id));
          break;
        }
        case "room.created":
        case "room.updated": {
          const r = payload as Room;
          setRooms(curr => {
            const exists = curr.some(x => x.id === r.id);
            if (exists) return curr.map(x => x.id === r.id ? r : x);
            return [r, ...curr];
          });
          break;
        }
        case "room.deleted": {
          const { id } = payload as { id: string };
          setRooms(curr => curr.filter(x => x.id !== id));
          if (currentRoomId === id) setCurrentRoomId(undefined);
          break;
        }
        case "messages.cleared": {
          const { roomId } = payload as { roomId: string };
          if (roomId === currentRoomId) setMessages([]);
          break;
        }
        case "project.updated": {
          api.listProjects().then(setProjects).catch(() => {});
          break;
        }
        case "agent.created":
        case "agent.updated":
        case "agent.status": {
          const a = payload as Agent;
          setAgents(curr => {
            const exists = curr.some(x => x.id === a.id);
            if (exists) return curr.map(x => x.id === a.id ? a : x);
            return [...curr, a];
          });
          break;
        }
        case "agent.thinking": {
          const p = payload as { roomId: string; agentId: string; message?: string; pending?: boolean };
          if (p.roomId === currentRoomId && p.agentId) {
            setStreamingAgentId(p.agentId);
          }
          pushActivity({
            roomId: p.roomId,
            kind: "agent.thinking",
            agentId: p.agentId,
            message: p.message ?? "Thinking…",
            pending: p.pending,
          });
          break;
        }
        case "agent.tool_call": {
          const p = payload as { roomId: string; agentId: string; tool: string; meta?: Record<string, unknown> };
          pushActivity({
            roomId: p.roomId,
            kind: "agent.tool_call",
            agentId: p.agentId,
            message: p.tool,
            meta: p.meta,
          });
          break;
        }
        case "agent.handoff": {
          const p = payload as { roomId: string; from: string; to: string; reason: string };
          pushActivity({
            roomId: p.roomId,
            kind: "agent.handoff",
            agentId: p.to,
            message: `Handoff from ${p.from} → ${p.to} (${p.reason})`,
          });
          break;
        }
        case "agent.completed": {
          const p = payload as { roomId: string; agentId: string; elapsedMs?: number };
          if (p.roomId === currentRoomId && streamingAgentId === p.agentId) {
            setStreamingAgentId(undefined);
          }
          pushActivity({
            roomId: p.roomId,
            kind: "agent.completed",
            agentId: p.agentId,
            message: `Finished in ${(p.elapsedMs ?? 0)}ms`,
            meta: { elapsedMs: p.elapsedMs },
          });
          break;
        }
        case "agent.error": {
          const p = payload as { roomId: string; agentId: string; error: string };
          if (p.roomId === currentRoomId && streamingAgentId === p.agentId) {
            setStreamingAgentId(undefined);
          }
          pushActivity({
            roomId: p.roomId,
            kind: "agent.error",
            agentId: p.agentId,
            message: p.error,
          });
          break;
        }
        case "self_talk.tick": {
          const p = payload as { roomId: string; agentId: string };
          pushActivity({ roomId: p.roomId, kind: "self_talk.tick", agentId: p.agentId, message: "Self-talk tick" });
          break;
        }
        case "activity.cleared": {
          setActivities([]);
          break;
        }
        case "system.warning":
        case "system.info":
        case "system.error": {
          const p = payload as { reason?: string; error?: string };
          if (event === "system.warning") toast.warning(p.reason ?? "warning", p);
          else if (event === "system.error") toast.error(p.error ?? "error", p);
          break;
        }
        case "self_talk.start":
        case "self_talk.stop":
        case "escalation":
        case "rework":
        case "finding.accepted":
        case "finding.rejected":
        case "review.completed": {
          if (currentRoomId) api.listRoomEvents(currentRoomId).then(setEvents).catch(() => {});
          break;
        }
      }
    });
    return unsub;
  }, [currentRoomId, streamingAgentId, pushActivity]);

  // Clear streamingAgent when switching rooms
  useEffect(() => {
    setStreamingAgentId(undefined);
  }, [currentRoomId]);

  // Handlers
  const handleCreateRoom = useCallback(async (body: { name: string; topic: string; projectId?: string }) => {
    try {
      const room = await api.createRoom(body);
      setRooms(curr => [room, ...curr]);
      setCurrentRoomId(room.id);
      setCreateOpen(false);
    } catch (err) {
      atchDebug.error("app", "create room failed", { error: String(err) });
    }
  }, []);

  const handleSendMessage = useCallback(async (content: string, _mentionedIds: string[]) => {
    if (!currentRoomId) return;
    try {
      await api.sendMessage(currentRoomId, { content });
    } catch (err) {
      atchDebug.error("app", "send message failed", { error: String(err) });
    }
  }, [currentRoomId]);

  const handleClearRoom = useCallback(() => {
    if (!currentRoomId) return;
    setConfirm({
      title: "Clear messages?",
      description: "This will delete all messages in this room.",
      destructive: true,
      onConfirm: async () => {
        await api.clearRoomMessages(currentRoomId);
        setMessages([]);
        toast.info("Messages cleared");
      },
    });
  }, [currentRoomId]);

  const handleDeleteRoom = useCallback(() => {
    if (!currentRoomId) return;
    setConfirm({
      title: "Delete room?",
      description: "This will permanently delete this room and all its data.",
      destructive: true,
      onConfirm: async () => {
        await api.deleteRoom(currentRoomId);
        setCurrentRoomId(undefined);
      },
    });
  }, [currentRoomId]);

  const handleSaveRoom = useCallback(async (patch: Partial<Room>) => {
    if (!currentRoomId) return;
    const updated = await api.updateRoom(currentRoomId, patch);
    setRooms(curr => curr.map(r => r.id === updated.id ? updated : r));
  }, [currentRoomId]);

  const handleCreateTask = useCallback(async (title: string) => {
    if (!currentRoomId) return;
    await api.createTask(currentRoomId, { title });
  }, [currentRoomId]);

  const handleUpdateTask = useCallback(async (id: string, patch: Partial<Task>) => {
    await api.updateTask(id, patch);
  }, []);

  const handleDeleteTask = useCallback(async (id: string) => {
    await api.deleteTask(id);
  }, []);

  const handleSaveNotes = useCallback(async (notes: string) => {
    if (!currentRoomId) return;
    await api.updateRoom(currentRoomId, { notes });
  }, [currentRoomId]);

  const handleReview = useCallback(async () => {
    if (!currentRoomId) return;
    const lastAgent = [...messages].reverse().find(m => m.authorId !== "user");
    if (!lastAgent) { toast.warning("No agent output to review"); return; }
    try {
      const r = await api.requestReview({ document: lastAgent.content, panel: "default", context: currentRoom?.name });
      setReviewResult(r);
      toast.info(r.summary);
    } catch (err) {
      toast.error("Review failed", { detail: String(err) });
    }
  }, [currentRoomId, messages, currentRoom]);

  const handleExport = useCallback(() => {
    if (!currentRoom) return;
    const blob = new Blob([JSON.stringify({ room: currentRoom, messages, tasks }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentRoom.name}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [currentRoom, messages, tasks]);

  const handleToggleSelfTalk = useCallback(() => {
    if (!currentRoomId) return;
    api.selfTalkTick(currentRoomId).catch(() => {});
  }, [currentRoomId]);

  const handleStopStreaming = useCallback(() => {
    setStreamingAgentId(undefined);
    toast.info("Stopped current generation");
  }, []);

  const handleStopAll = useCallback(() => {
    setStreamingAgentId(undefined);
    setActivities([]);
    toast.info("Stopped all running agents and cleared activity");
  }, []);

  const handleToggleRightPanel = useCallback(() => {
    setRightPanelOpen(v => !v);
  }, []);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading Atelier…
      </div>
    );
  }
  if (error) {
    return (
      <div className="h-screen flex items-center justify-center text-sm text-red-600">
        Failed to connect to server: {error}
      </div>
    );
  }

  return (
    <>
      <AppShell
        rooms={rooms}
        projects={projects}
        agents={agents}
        currentRoom={currentRoom}
        messages={messages}
        tasks={tasks}
        events={events}
        findings={findings}
        activities={activities}
        streamingAgent={streamingAgent}
        wsStatus={wsStatus}
        showRightPanel={rightPanelOpen}
        onSelectRoom={setCurrentRoomId}
        onCreateRoom={() => setCreateOpen(true)}
        onSendMessage={handleSendMessage}
        onToggleSelfTalk={handleToggleSelfTalk}
        onReview={handleReview}
        onExport={handleExport}
        onClearRoom={handleClearRoom}
        onDeleteRoom={handleDeleteRoom}
        onRoomSettings={() => setSettingsOpen(true)}
        onInvite={() => setSettingsOpen(true)}
        onCreateTask={handleCreateTask}
        onUpdateTask={handleUpdateTask}
        onDeleteTask={handleDeleteTask}
        onSaveNotes={handleSaveNotes}
        onStopStreaming={handleStopStreaming}
        onStopAll={handleStopAll}
        onToggleRightPanel={handleToggleRightPanel}
      />

      <CreateRoomDialog open={createOpen} onClose={() => setCreateOpen(false)} projects={projects} onCreate={handleCreateRoom} />
      {currentRoom && (
        <RoomSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} room={currentRoom} agents={agents} onSave={handleSaveRoom} />
      )}
      <TaskEditDialog open={taskDialogOpen} onClose={() => setTaskDialogOpen(false)} task={editingTask} agents={agents} onSave={(_patch: Partial<Task>) => { setTaskDialogOpen(false); }} />
      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          title={confirm.title}
          description={confirm.description}
          destructive={confirm.destructive}
          onConfirm={confirm.onConfirm}
        />
      )}
      {reviewResult && (
        <div className="fixed bottom-4 right-4 bg-popover border rounded-lg p-4 max-w-md shadow-xl">
          <div className="font-semibold text-sm mb-2">Review: {reviewResult.summary}</div>
          <button className="text-xs underline" onClick={() => setReviewResult(null)}>close</button>
        </div>
      )}
      <Toaster />
    </>
  );
}