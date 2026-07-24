import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { CreateRoomDialog } from "@/components/CreateRoomDialog";
import { RoomSettingsDialog } from "@/components/RoomSettingsDialog";
import { TaskEditDialog } from "@/components/TaskEditDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
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
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [streamingAgentId, setStreamingAgentId] = useState<string | undefined>();
  const [streamingText, setStreamingText] = useState<Record<string, string>>({});
  const [streamingTool, setStreamingTool] = useState<Record<string, string>>({});
  const [activeRunId, setActiveRunId] = useState<string | undefined>();
  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");

  // rAF-batched streaming buffers: WS events arrive faster than 60fps and we
  // don't want to thrash React. Accumulate deltas in refs and flush per frame.
  const streamBufferRef = useRef<Record<string, string>>({});
  const streamToolRef = useRef<Record<string, string | null>>({});
  const rafIdRef = useRef<number | null>(null);
  const flushStream = () => {
    rafIdRef.current = null;
    const txt = streamBufferRef.current;
    const tl = streamToolRef.current;
    if (Object.keys(txt).length === 0 && Object.keys(tl).length === 0) return;
    setStreamingText(prev => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(txt)) {
        next[k] = (next[k] ?? "") + v;
      }
      return next;
    });
    setStreamingTool(prev => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(tl)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      return next;
    });
    streamBufferRef.current = {};
    streamToolRef.current = {};
  };
  const scheduleFlush = () => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(flushStream);
  };
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

  // Re-fetch room data on WS reconnect (missed events during disconnect gap)
  useEffect(() => {
    const unsub = ws.onReconnect(() => {
      if (!currentRoomId) return;
      Promise.all([
        api.listMessages(currentRoomId),
        api.listTasks(currentRoomId),
        api.listRoomEvents(currentRoomId),
      ]).then(([msgs, tks, evs]) => {
        setMessages(msgs);
        setTasks(tks);
        setEvents(evs);
      }).catch(() => {});
    });
    return unsub;
  }, [currentRoomId]);

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
          const p = payload as { roomId: string; agentId: string; message?: string; pending?: boolean; runId?: string };
          if (p.roomId === currentRoomId && p.agentId && !p.pending) {
            setStreamingAgentId(p.agentId);
            if (p.runId) setActiveRunId(p.runId);
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
          const p = payload as { roomId: string; agentId: string; tool: string };
          if (p.roomId === currentRoomId && p.agentId) {
            streamToolRef.current[p.agentId] = p.tool;
            scheduleFlush();
          }
          pushActivity({
            roomId: p.roomId,
            kind: "agent.tool_call",
            agentId: p.agentId,
            message: p.tool,
          });
          break;
        }
        case "agent.text_delta": {
          const p = payload as { roomId: string; agentId: string; delta: string };
          if (p.roomId === currentRoomId && p.agentId) {
            streamBufferRef.current[p.agentId] = (streamBufferRef.current[p.agentId] ?? "") + p.delta;
            scheduleFlush();
          }
          break;
        }
        case "agent.step_done": {
          const p = payload as { roomId: string; agentId: string; reason: string };
          pushActivity({
            roomId: p.roomId,
            kind: "agent.thinking",
            agentId: p.agentId,
            message: `Step finished (${p.reason})`,
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
          const p = payload as { roomId: string; agentId: string; elapsedMs?: number; runId?: string };
          if (p.roomId === currentRoomId && streamingAgentId === p.agentId) {
            setStreamingAgentId(undefined);
          }
          if (activeRunId && p.runId === activeRunId) setActiveRunId(undefined);
          // clear streaming buffers immediately (not via rAF) so no stale delta
          // leaks into a future run by the same agent.
          delete streamBufferRef.current[p.agentId];
          delete streamToolRef.current[p.agentId];
          setStreamingText(curr => {
            const next = { ...curr };
            delete next[p.agentId];
            return next;
          });
          setStreamingTool(curr => {
            const next = { ...curr };
            delete next[p.agentId];
            return next;
          });
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
          setActiveRunId(undefined);
          delete streamBufferRef.current[p.agentId];
          delete streamToolRef.current[p.agentId];
          setStreamingText(curr => {
            const next = { ...curr };
            delete next[p.agentId];
            return next;
          });
          setStreamingTool(curr => {
            const next = { ...curr };
            delete next[p.agentId];
            return next;
          });
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
  }, [currentRoomId, streamingAgentId, activeRunId, pushActivity, scheduleFlush]);

  // Clear streamingAgent when switching rooms
  useEffect(() => {
    setStreamingAgentId(undefined);
    setStreamingText({});
    setStreamingTool({});
  }, [currentRoomId]);

  // Handlers
  const handleCreateRoom = useCallback(async (body: { name: string; topic: string; projectId?: string }) => {
    try {
      const room = await api.createRoom(body);
      setRooms(curr => {
        const exists = curr.some(x => x.id === room.id);
        return exists ? curr.map(x => x.id === room.id ? room : x) : [room, ...curr];
      });
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

  const handleStopStreaming = useCallback(async () => {
    if (!currentRoomId) return;
    try {
      await api.stopAgent({
        roomId: currentRoomId,
        agentId: streamingAgentId,
        runId: activeRunId,
      });
      setStreamingAgentId(undefined);
      setActiveRunId(undefined);
      toast.info("Stopped current generation");
    } catch (err) {
      toast.error("Failed to stop", { detail: String(err) });
    }
  }, [currentRoomId, streamingAgentId, activeRunId]);

  const handleStopAll = useCallback(async () => {
    // Ask the server to actually cancel in-flight runs before clearing local
    // UI state — otherwise the agent can still complete and emit messages
    // after the panel claims it was stopped.
    try {
      const result = await api.stopAgents(currentRoomId ? { roomId: currentRoomId } : {});
      setStreamingAgentId(undefined);
      setActivities([]);
      if (result.cancelled > 0) {
        toast.info(`Stopped ${result.cancelled} running agent${result.cancelled === 1 ? "" : "s"}`);
      } else {
        toast.info("No running agents to stop");
      }
    } catch (err) {
      atchDebug.error("app", "stop-all failed", { error: String(err) });
      toast.error("Failed to stop agents", { detail: String(err) });
    }
  }, [currentRoomId]);

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
    <ErrorBoundary>
    <>
      <AppShell
        rooms={rooms}
        projects={projects}
        agents={agents}
        currentRoom={currentRoom}
        messages={messages}
        streamingText={streamingText}
        streamingTool={streamingTool}
        tasks={tasks}
        events={events}
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
        <div className="fixed bottom-20 right-4 bg-popover border rounded-lg p-4 max-w-md shadow-xl z-50">
          <div className="font-semibold text-sm mb-2">Review: {reviewResult.summary}</div>
          <button className="text-xs underline" onClick={() => setReviewResult(null)}>close</button>
        </div>
      )}
      <Toaster />
    </>
    </ErrorBoundary>
  );
}