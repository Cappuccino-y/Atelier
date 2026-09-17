import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { CreateRoomDialog } from "@/components/CreateRoomDialog";
import { RoomSettingsDialog } from "@/components/RoomSettingsDialog";
import { TaskEditDialog } from "@/components/TaskEditDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { HandoffChainDialog } from "@/components/chat/HandoffChainDialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { ws } from "@/lib/ws";
import { atchDebug } from "@/lib/atch-debug";
import type {
  Agent, Attachment, Message, Room, Project, Task, Finding, Event, ServerEvent, ActivityEvent, ActivityKind, MemoryEntry,
} from "@/types";
import { type LiveRun, type RunningRun } from "@/components/chat/RunningDock";
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

/**
 * Human-readable one-line summary of a tool call's input, for the running
 * dock / live panel ("which command is this agent running right now?").
 */
function summarizeToolInput(tool: string, input: unknown): string | null {
  if (input == null || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const firstStr = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };
  switch (tool) {
    case "bash":
      return firstStr("command", "cmd", "script");
    case "read":
    case "write":
    case "edit":
      return firstStr("filePath", "file_path", "path", "notebook_path");
    case "glob":
      return firstStr("pattern");
    case "grep":
      return firstStr("pattern", "query");
    case "task":
    case "todowrite":
      return null; // too noisy to summarize
    default:
      return firstStr("command", "query", "url", "path", "pattern", "description", "prompt");
  }
}

export default function App() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [currentRoomId, setCurrentRoomId] = useState<string | undefined>();
  const [roomLoading, setRoomLoading] = useState(false);
  const [roomLoadError, setRoomLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [streamingText, setStreamingText] = useState<Record<string, string>>({});
  const [streamingTool, setStreamingTool] = useState<Record<string, string>>({});
  // tool input summary per run-key (e.g. bash command text) — shown alongside
  // the tool chip in the running dock / live panel
  const [streamingToolInput, setStreamingToolInput] = useState<Record<string, string>>({});
  // Live runs keyed by runId (fallback `${roomId}:${agentId}`). runId-granular
  // so parallel same-role instances (to:["forge","forge"]) render as separate
  // rows in the running dock.
  const [liveRuns, setLiveRuns] = useState<Record<string, LiveRun>>({});
  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");

  // rAF-batched streaming buffers: WS events arrive faster than 60fps and we
  // don't want to thrash React. Accumulate deltas in refs and flush per frame.
  // Both callbacks are useCallback-stable (only depend on setters) so the WS
  // subscription effect below never re-binds on streaming re-renders.
  const streamBufferRef = useRef<Record<string, string>>({});
  const streamToolRef = useRef<Record<string, string | null>>({});
  const streamToolInputRef = useRef<Record<string, string | null>>({});
  const rafIdRef = useRef<number | null>(null);
  const flushStream = useCallback(() => {
    rafIdRef.current = null;
    const txt = streamBufferRef.current;
    const tl = streamToolRef.current;
    const ti = streamToolInputRef.current;
    if (Object.keys(txt).length === 0 && Object.keys(tl).length === 0 && Object.keys(ti).length === 0) return;
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
    setStreamingToolInput(prev => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(ti)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      return next;
    });
    streamBufferRef.current = {};
    streamToolRef.current = {};
    streamToolInputRef.current = {};
  }, []);
  const scheduleFlush = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(flushStream);
  }, [flushStream]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingTask] = useState<Task | undefined>();
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; description?: string; destructive?: boolean; onConfirm: () => void } | null>(null);
  const [reviewResult, setReviewResult] = useState<{ findings: Finding[]; summary: string } | null>(null);
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([]);
  const [chainMessage, setChainMessage] = useState<Message | null>(null);

  const currentRoom = useMemo(() => rooms.find(r => r.id === currentRoomId), [rooms, currentRoomId]);
  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);

  // current room's runs — display shape for the RunningDock, with parallel
  // same-role instances numbered (Forge, Forge ·2, …)
  const roomRuns = useMemo(() => {
    if (!currentRoomId) return [];
    const list = Object.values(liveRuns).filter(r => r.roomId === currentRoomId);
    const perAgent: Record<string, number> = {};
    return list
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(r => {
        const agent = agentMap.get(r.agentId);
        if (!agent) return null;
        perAgent[r.agentId] = (perAgent[r.agentId] ?? 0) + 1;
        // per-run stream buffers (runId-keyed): parallel same-role instances
        // each surface their own tool + tail in the dock
        const sKey = r.runId ? `${currentRoomId}:${r.runId}` : `${currentRoomId}:${r.agentId}`;
        return {
          key: r.key,
          agent,
          startedAt: r.startedAt,
          lastEventAt: r.lastEventAt,
          runId: r.runId,
          tool: streamingTool[sKey] ?? r.lastTool,
          toolInput: streamingToolInput[sKey],
          textTail: streamingText[sKey]?.slice(-180),
          instanceLabel: perAgent[r.agentId] > 1 ? `#${perAgent[r.agentId]}` : undefined,
        } as RunningRun;
      })
      .filter((r): r is RunningRun => r !== null);
  }, [liveRuns, currentRoomId, agentMap, streamingTool, streamingToolInput, streamingText]);

  // inline streaming cards for the message list — same data as roomRuns but
  // keyed by runId so parallel instances never interleave, with a longer
  // text tail (cards are the primary streaming surface; the dock is the
  // compact one)
  const streamingCards = useMemo(() => {
    if (!currentRoomId) return [];
    const perAgent: Record<string, number> = {};
    const ordered = Object.values(liveRuns)
      .filter(r => r.roomId === currentRoomId)
      .sort((a, b) => a.startedAt - b.startedAt);
    return ordered
      .map(r => {
        const agent = agentMap.get(r.agentId);
        if (!agent) return null;
        perAgent[r.agentId] = (perAgent[r.agentId] ?? 0) + 1;
        const sKey = r.runId ? `${currentRoomId}:${r.runId}` : `${currentRoomId}:${r.agentId}`;
        return {
          key: r.key,
          agent,
          runId: r.runId,
          startedAt: r.startedAt,
          tool: streamingTool[sKey] ?? r.lastTool,
          toolInput: streamingToolInput[sKey],
          // FULL accumulated text — the card bottom-pins its scroll; slicing
          // a tail window here causes the top-line shrink/reflow bug
          textTail: streamingText[sKey],
          instanceLabel: perAgent[r.agentId] > 1 ? `#${perAgent[r.agentId]}` : undefined,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, [liveRuns, currentRoomId, agentMap, streamingTool, streamingToolInput, streamingText]);

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

  // Desktop notification for background completions — kept in refs so the WS
  // subscription never re-binds because of these lookups.
  const roomRef = useRef(currentRoomId);
  roomRef.current = currentRoomId;
  const agentNamesRef = useRef<Record<string, string>>({});
  agentNamesRef.current = Object.fromEntries(agents.map(a => [a.id, a.name]));
  const notifyIfHidden = useCallback((roomId: string, agentId: string, verb: string, detail?: string) => {
    if (typeof Notification === "undefined") return;
    if (!document.hidden && roomId === roomRef.current) return; // user is watching this room
    try {
      if (Notification.permission !== "granted") return;
      const name = agentNamesRef.current[agentId] ?? "Agent";
      const n = new Notification(`@${name} ${verb}`, {
        body: detail ?? "Task finished in Atelier",
        tag: `atelier-${roomId}-${agentId}`,
      });
      setTimeout(() => n.close(), 6000);
    } catch { /* notifications unavailable */ }
  }, []);

  // Reconcile the activity-derived live runs against the server's authoritative
  // run registry. After a page refresh this ADDS runs the UI missed; after a
  // server stop/start cycle the registry is empty, which clears zombie rows.
  const syncServerRuns = useCallback(async () => {
    try {
      const { runs } = await api.listRuns();
      const byRunId = new Map(runs.map(r => [r.runId, r]));
      setLiveRuns(prev => {
        const next: Record<string, LiveRun> = {};
        for (const [k, r] of Object.entries(prev)) {
          const server = r.runId ? byRunId.get(r.runId) : undefined;
          const stub = !r.runId
            ? runs.find(s => s.roomId === r.roomId && s.agentId === r.agentId)
            : undefined;
          const match = server ?? stub;
          if (match) next[k] = r; // confirmed alive
        }
        for (const s of runs) {
          const known = Object.values(next).some(
            r => (r.runId && r.runId === s.runId) || (r.roomId === s.roomId && r.agentId === s.agentId),
          );
          if (!known) {
            next[s.runId] = {
              key: s.runId,
              roomId: s.roomId ?? "",
              agentId: s.agentId ?? "",
              runId: s.runId,
              startedAt: s.startedAt,
              lastEventAt: s.startedAt,
            };
          }
        }
        return next;
      });
    } catch { /* endpoint unavailable — keep activity-derived state */ }
  }, []);

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
      syncServerRuns();
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
      syncServerRuns();
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
  }, [currentRoomId, syncServerRuns]);

  // Desktop notifications — request permission lazily on first interaction;
  // notify when an agent finishes/fails in the background (tab hidden).
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    const ask = () => {
      if (Notification.permission === "default") Notification.requestPermission().catch(() => {});
      window.removeEventListener("pointerdown", ask);
      window.removeEventListener("keydown", ask);
    };
    window.addEventListener("pointerdown", ask, { once: true });
    window.addEventListener("keydown", ask, { once: true });
    return () => {
      window.removeEventListener("pointerdown", ask);
      window.removeEventListener("keydown", ask);
    };
  }, []);

  // Load room data when room changes
  useEffect(() => {
    if (!currentRoomId) return;
    let cancelled = false;
    // Clear stale room content immediately so we never show the previous
    // room's messages under the new room's header while data loads.
    setMessages([]);
    setTasks([]);
    setEvents([]);
    setMemoryEntries([]);
    setRoomLoading(true);
    setRoomLoadError(null);
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
        if (!cancelled) setRoomLoadError(err instanceof Error ? err.message : String(err));
      }
      // fetch memory separately (can be slow)
      try {
        const mem = await api.listRoomMemory(currentRoomId);
        if (!cancelled) setMemoryEntries(mem.entries);
      } catch { /* memory may not be enabled */ }
      // fetch past activities for Live/Tools tab
      try {
        const acts = await api.listRoomActivities(currentRoomId);
        if (!cancelled) {
          setActivities(curr => {
            // merge: keep live events from OTHER rooms, replace current room's with server data
            const others = curr.filter(a => a.roomId !== currentRoomId);
            // server data is newest-first, reverse to match pushActivity (newest last for chrono sort)
            return [...others, ...acts.reverse()];
          });
          // rebuild live runs from persisted activities so the running dock
          // survives a page refresh. runId-granular when the server recorded
          // it, agentId-keyed otherwise (live WS events upgrade it later).
          const chrono = [...acts].reverse();
          setLiveRuns(prev => {
            const next: Record<string, LiveRun> = {};
            for (const [k, r] of Object.entries(prev)) {
              if (r.roomId !== currentRoomId) next[k] = r;
            }
            for (const ev of chrono) {
              if (!ev.agentId) continue;
              const runId = typeof ev.meta?.runId === "string" ? ev.meta.runId : undefined;
              const key = runId ?? `${currentRoomId}:${ev.agentId}`;
              const sameRoomAgent = (r: LiveRun) =>
                r.roomId === currentRoomId && r.agentId === ev.agentId;
              if (ev.kind === "agent.thinking" && !ev.pending) {
                const existing = next[key];
                next[key] = existing
                  ? { ...existing, lastEventAt: ev.timestamp }
                  : { key, roomId: currentRoomId, agentId: ev.agentId, runId, startedAt: ev.timestamp, lastEventAt: ev.timestamp };
              } else if (ev.kind === "agent.tool_call") {
                const tool = typeof ev.meta?.tool === "string" ? ev.meta.tool : (ev.message || undefined);
                const existing = next[key];
                next[key] = existing
                  ? { ...existing, lastEventAt: ev.timestamp, lastTool: tool ?? existing.lastTool }
                  : { key, roomId: currentRoomId, agentId: ev.agentId, runId, startedAt: ev.timestamp, lastEventAt: ev.timestamp, lastTool: tool };
              } else if (ev.kind === "agent.completed" || ev.kind === "agent.error") {
                for (const k of Object.keys(next)) {
                  const r = next[k];
                  const match = runId
                    ? r.runId === runId
                    : sameRoomAgent(r);
                  if (match) delete next[k];
                }
              }
            }
            return next;
          });
        }
      } catch { /* no persisted activities */ }
      // activities may have re-seeded runs — reconcile against the server's
      // authoritative registry AFTER the rebuild so zombies can't come back
      void syncServerRuns();
      if (!cancelled) setRoomLoading(false);
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
        case "message.updated": {
          const msg = payload as Message;
          if (msg.roomId === currentRoomId) {
            setMessages(curr => curr.map(m => m.id === msg.id ? msg : m));
          }
          break;
        }
        case "message.deleted": {
          const p = payload as { roomId: string; messageId: string };
          if (p.roomId === currentRoomId) {
            setMessages(curr => curr.filter(m => m.id !== p.messageId));
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
          const p = payload as Project & { deleted?: boolean };
          if (p.deleted) {
            setProjects(curr => curr.filter(x => x.id !== p.id));
          } else {
            setProjects(curr => {
              const exists = curr.some(x => x.id === p.id);
              return exists ? curr.map(x => x.id === p.id ? p : x) : [...curr, p];
            });
          }
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
          if (p.agentId && !p.pending) {
            const now = Date.now();
            const key = p.runId ?? `${p.roomId}:${p.agentId}`;
            setLiveRuns(prev => {
              const next = { ...prev };
              // a runId-keyed run supersedes any agentId-keyed stub (REST rebuild)
              if (p.runId) {
                for (const k of Object.keys(next)) {
                  if (next[k].roomId === p.roomId && next[k].agentId === p.agentId && !next[k].runId) delete next[k];
                }
              }
              const existing = next[key];
              next[key] = existing
                ? { ...existing, lastEventAt: now }
                : { key, roomId: p.roomId, agentId: p.agentId, runId: p.runId, startedAt: now, lastEventAt: now };
              return next;
            });
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
          const p = payload as { roomId: string; agentId: string; runId?: string; tool: string; input?: unknown };
          const inputSummary = summarizeToolInput(p.tool, p.input);
          if (p.roomId === currentRoomId && p.agentId) {
            // per-RUN key: parallel same-role instances (forge/forge#2) each
            // get their own tool chip + streaming tail in the running dock
            const tKey = p.runId ? `${p.roomId}:${p.runId}` : `${p.roomId}:${p.agentId}`;
            streamToolRef.current[tKey] = p.tool;
            streamToolInputRef.current[tKey] = inputSummary;
            scheduleFlush();
          }
          const now = Date.now();
          setLiveRuns(prev => {
            let changed = false;
            const next = { ...prev };
            for (const k of Object.keys(next)) {
              const r = next[k];
              if (r.roomId === p.roomId && r.agentId === p.agentId) {
                next[k] = { ...r, lastEventAt: now, lastTool: p.tool };
                changed = true;
              }
            }
            return changed ? next : prev;
          });
          pushActivity({
            roomId: p.roomId,
            kind: "agent.tool_call",
            agentId: p.agentId,
            message: p.tool,
            meta: { tool: p.tool, input: inputSummary ?? undefined },
          });
          break;
        }
        case "agent.text_delta": {
          const p = payload as { roomId: string; agentId: string; runId?: string; delta: string };
          if (p.roomId === currentRoomId && p.agentId) {
            const key = p.runId ? `${p.roomId}:${p.runId}` : `${p.roomId}:${p.agentId}`;
            streamBufferRef.current[key] = (streamBufferRef.current[key] ?? "") + p.delta;
            scheduleFlush();
          }
          const now = Date.now();
          setLiveRuns(prev => {
            let changed = false;
            const next = { ...prev };
            for (const k of Object.keys(next)) {
              const r = next[k];
              if (r.roomId === p.roomId && r.agentId === p.agentId) {
                next[k] = { ...r, lastEventAt: now };
                changed = true;
              }
            }
            return changed ? next : prev;
          });
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
          setLiveRuns(prev => {
            const next = { ...prev };
            for (const k of Object.keys(next)) {
              const r = next[k];
              const match = p.runId ? r.runId === p.runId : (r.roomId === p.roomId && r.agentId === p.agentId);
              if (match) delete next[k];
            }
            return next;
          });
          // clear streaming buffers immediately (not via rAF) so no stale delta
          // leaks into a future run by the same agent. Both the agentId-keyed
          // and runId-keyed buffers are cleared (parallel instances buffer
          // under their own runId).
          const streamKey = `${p.roomId}:${p.agentId}`;
          const runStreamKey = p.runId ? `${p.roomId}:${p.runId}` : streamKey;
          for (const sk of new Set([streamKey, runStreamKey])) {
            delete streamBufferRef.current[sk];
            delete streamToolRef.current[sk];
          }
          setStreamingText(curr => {
            const next = { ...curr };
            delete next[streamKey];
            delete next[runStreamKey];
            return next;
          });
          setStreamingTool(curr => {
            const next = { ...curr };
            delete next[streamKey];
            delete next[runStreamKey];
            return next;
          });
          pushActivity({
            roomId: p.roomId,
            kind: "agent.completed",
            agentId: p.agentId,
            message: `Finished in ${(p.elapsedMs ?? 0)}ms`,
            meta: { elapsedMs: p.elapsedMs },
          });
          notifyIfHidden(p.roomId, p.agentId, "finished", p.elapsedMs ? `${(p.elapsedMs / 1000).toFixed(1)}s` : undefined);
          break;
        }
        case "agent.error": {
          const p = payload as { roomId: string; agentId: string; runId?: string; error: string };
          setLiveRuns(prev => {
            const next = { ...prev };
            for (const k of Object.keys(next)) {
              const r = next[k];
              const match = r.roomId === p.roomId && r.agentId === p.agentId;
              if (match) delete next[k];
            }
            return next;
          });
          const streamKey2 = `${p.roomId}:${p.agentId}`;
          const runStreamKey2 = p.runId ? `${p.roomId}:${p.runId}` : streamKey2;
          for (const sk of new Set([streamKey2, runStreamKey2])) {
            delete streamBufferRef.current[sk];
            delete streamToolRef.current[sk];
          }
          setStreamingText(curr => {
            const next = { ...curr };
            delete next[streamKey2];
            delete next[runStreamKey2];
            return next;
          });
          setStreamingTool(curr => {
            const next = { ...curr };
            delete next[streamKey2];
            delete next[runStreamKey2];
            return next;
          });
          pushActivity({
            roomId: p.roomId,
            kind: "agent.error",
            agentId: p.agentId,
            message: p.error,
          });
          notifyIfHidden(p.roomId, p.agentId, "failed", p.error?.slice(0, 120));
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
  }, [currentRoomId, pushActivity, scheduleFlush]);

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

  const handleSendMessage = useCallback(async (content: string, mentionedIds: string[], attachments?: Attachment[], interrupt?: boolean) => {
    if (!currentRoomId) return;
    try {
      if (interrupt) {
        // Interrupt-and-steer: server aborts live runs, attaches an interrupt
        // report, and routes the correction (default target: atlas)
        await api.interruptSteer(currentRoomId, { content, mentionedAgentIds: mentionedIds });
      } else {
        await api.sendMessage(currentRoomId, { content, mentionedAgentIds: mentionedIds, attachments });
      }
    } catch (err) {
      atchDebug.error("app", "send message failed", { error: String(err) });
      toast.error("Failed to send message", { detail: String(err) });
    }
  }, [currentRoomId]);

  const handleClearRoom = useCallback(() => {
    if (!currentRoomId) return;
    setConfirm({
      title: "Clear messages?",
      description: "This will delete all messages in this room.",
      destructive: true,
      onConfirm: async () => {
        try {
          await api.clearRoomMessages(currentRoomId);
          setMessages([]);
          toast.info("Messages cleared");
        } catch (err) {
          toast.error("Failed to clear messages", { detail: String(err) });
        }
      },
    });
  }, [currentRoomId]);

  const handleDeleteRoom = useCallback((roomId?: string) => {
    const target = roomId ?? currentRoomId;
    if (!target) return;
    setConfirm({
      title: "Delete room?",
      description: "This will permanently delete this room and all its data.",
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deleteRoom(target);
          if (currentRoomId === target) setCurrentRoomId(undefined);
        } catch (err) {
          toast.error("Failed to delete room", { detail: String(err) });
        }
      },
    });
  }, [currentRoomId]);

  const handleCreateProject = useCallback(async (name: string) => {
    try {
      await api.createProject(name);
    } catch (err) {
      toast.error("Failed to create project", { detail: String(err) });
    }
  }, []);

  const handleDeleteProject = useCallback((id: string, name: string) => {
    setConfirm({
      title: `Delete group "${name}"?`,
      description: "All rooms in this group and their data will be permanently deleted.",
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deleteProject(id);
        } catch (err) {
          toast.error("Failed to delete group", { detail: String(err) });
        }
      },
    });
  }, []);

  const handleMoveRoom = useCallback(async (roomId: string, projectId: string | null) => {
    try {
      const updated = await api.moveRoom(roomId, projectId);
      setRooms(curr => curr.map(r => r.id === updated.id ? updated : r));
    } catch (err) {
      toast.error("Failed to move room", { detail: String(err) });
    }
  }, []);

  const handleSaveRoom = useCallback(async (patch: Partial<Room>) => {
    if (!currentRoomId) return;
    try {
      const updated = await api.updateRoom(currentRoomId, patch);
      setRooms(curr => curr.map(r => r.id === updated.id ? updated : r));
    } catch (err) {
      toast.error("Failed to save room settings", { detail: String(err) });
    }
  }, [currentRoomId]);

  const handleCreateTask = useCallback(async (title: string) => {
    if (!currentRoomId) return;
    try {
      await api.createTask(currentRoomId, { title });
    } catch (err) {
      toast.error("Failed to create task", { detail: String(err) });
    }
  }, [currentRoomId]);

  const handleUpdateTask = useCallback(async (id: string, patch: Partial<Task>) => {
    try {
      await api.updateTask(id, patch);
    } catch (err) {
      toast.error("Failed to update task", { detail: String(err) });
    }
  }, []);

  const handleDeleteTask = useCallback(async (id: string) => {
    try {
      await api.deleteTask(id);
    } catch (err) {
      toast.error("Failed to delete task", { detail: String(err) });
    }
  }, []);

  const handleSaveNotes = useCallback(async (notes: string) => {
    if (!currentRoomId) return;
    try {
      await api.updateRoom(currentRoomId, { notes });
    } catch (err) {
      toast.error("Failed to save notes", { detail: String(err) });
    }
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

  const download = useCallback((content: string, ext: string, mime: string) => {
    if (!currentRoom) return;
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentRoom.name}-${Date.now()}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }, [currentRoom]);

  const agentNamesById = useMemo(
    () => new Map(agents.map(a => [a.id, a])),
    [agents]
  );

  const handleExport = useCallback(() => {
    if (!currentRoom) return;
    // Markdown transcript — the native format of the room content.
    const lines: string[] = [
      `# ${currentRoom.name}`,
      currentRoom.topic ? `> ${currentRoom.topic}` : "",
      "",
    ];
    for (const m of messages) {
      const who = m.authorId === "user" ? "You" : (agentNamesById.get(m.authorId)?.name ?? m.authorId);
      lines.push(`**${who}** · ${new Date(m.timestamp).toLocaleString()}`, "", m.content.trim(), "", "---", "");
    }
    if (tasks.length > 0) {
      lines.push("## Tasks", "");
      for (const t of tasks) {
        lines.push(`- [${t.status === "done" ? "x" : " "}] ${t.title} (${t.status})`);
      }
    }
    download(lines.join("\n"), "md", "text/markdown;charset=utf-8");
  }, [currentRoom, messages, tasks, agentNamesById, download]);

  const handleExportJson = useCallback(() => {
    if (!currentRoom) return;
    download(JSON.stringify({ room: currentRoom, messages, tasks }, null, 2), "json", "application/json");
  }, [currentRoom, messages, tasks, download]);

  const handleToggleSelfTalk = useCallback(() => {
    if (!currentRoomId) return;
    api.selfTalkTick(currentRoomId).catch(() => {});
  }, [currentRoomId]);

  const handleDeleteMessage = useCallback((message: Message) => {
    if (!currentRoomId) return;
    setConfirm({
      title: "Delete this message?",
      description: "It will be removed from the room history for everyone. This cannot be undone.",
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deleteMessage(currentRoomId, message.id);
          setMessages(curr => curr.filter(m => m.id !== message.id));
          toast.info("Message deleted");
        } catch (err) {
          toast.error("Failed to delete message", { detail: String(err) });
        }
      },
    });
  }, [currentRoomId]);

  const handleStopAgent = useCallback(async (agentId: string, runId?: string) => {
    if (!currentRoomId) return;
    // prefer the row's own runId; otherwise the server resolves by agent alias
    try {
      await api.stopAgent({
        roomId: currentRoomId,
        agentId,
        runId: runId ?? undefined,
      });
      toast.info("Stopped current generation");
    } catch (err) {
      toast.error("Failed to stop", { detail: String(err) });
    }
  }, [currentRoomId]);

  const handleStopAll = useCallback(async () => {
    try {
      const result = await api.stopAgents(currentRoomId ? { roomId: currentRoomId } : {});
      setLiveRuns(prev => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          if (!currentRoomId || next[k].roomId === currentRoomId) delete next[k];
        }
        return next;
      });
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
      <div className="h-screen flex flex-col bg-background">
        <div className="h-12 bg-zinc-50 border-b border-border" />
        <div className="flex flex-1 min-h-0">
          <div className="w-64 border-r border-border p-3 space-y-2">
            {[1,2,3,4,5].map(i => (
              <div key={i} className="h-10 shimmer rounded-lg" />
            ))}
          </div>
          <div className="flex-1 p-6 space-y-4">
            <div className="h-6 w-48 shimmer rounded-md" />
            <div className="space-y-3">
              {[1,2,3].map(i => (
                <div key={i} className="flex gap-3">
                  <div className="h-9 w-9 rounded-full shimmer shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-32 shimmer rounded" />
                    <div className="h-16 shimmer rounded-lg" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
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
        roomLoading={roomLoading}
        roomLoadError={roomLoadError}
        messages={messages}
        streamingText={streamingText}
        streamingTool={streamingTool}
        tasks={tasks}
        events={events}
        activities={activities}
        runs={roomRuns}
        streamingCards={streamingCards}
        wsStatus={wsStatus}
        showRightPanel={rightPanelOpen}
        onSelectRoom={setCurrentRoomId}
        onCreateRoom={() => setCreateOpen(true)}
        onSendMessage={handleSendMessage}
        onToggleSelfTalk={handleToggleSelfTalk}
        onReview={handleReview}
        onExport={handleExport}
        onExportJson={handleExportJson}
        onClearRoom={handleClearRoom}
        onDeleteRoom={handleDeleteRoom}
        onRoomSettings={() => setSettingsOpen(true)}
        onInvite={() => setSettingsOpen(true)}
        onCreateTask={handleCreateTask}
        onUpdateTask={handleUpdateTask}
        onDeleteTask={handleDeleteTask}
        onSaveNotes={handleSaveNotes}
        onStopAgent={handleStopAgent}
        onStopAll={handleStopAll}
        onToggleRightPanel={handleToggleRightPanel}
        onCreateProject={handleCreateProject}
        onDeleteProject={handleDeleteProject}
        onMoveRoom={handleMoveRoom}
        onShowChain={(m) => setChainMessage(m)}
        onDeleteMessage={handleDeleteMessage}
        memoryEntries={memoryEntries}
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
        <Dialog open onOpenChange={v => !v && setReviewResult(null)}>
          <DialogContent className="max-w-lg max-h-[70vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-base">Proserpina review</DialogTitle>
              <DialogDescription>{reviewResult.summary}</DialogDescription>
            </DialogHeader>
            {reviewResult.findings.length === 0 ? (
              <p className="text-[13px] text-zinc-500">No findings — clean pass.</p>
            ) : (
              <ul className="space-y-2">
                {reviewResult.findings.map((f, i) => (
                  <li key={i} className="rounded-lg border border-zinc-200 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`tag-badge ${
                        f.severity === "critical" ? "bg-red-50 text-red-700 border-red-200"
                        : f.severity === "major" ? "bg-amber-50 text-amber-700 border-amber-200"
                        : "bg-sky-50 text-sky-700 border-sky-200"}`}>
                        {f.severity}
                      </span>
                      <span className="text-[12.5px] font-medium text-zinc-800">{f.title}</span>
                    </div>
                    {f.suggested && (
                      <p className="mt-1 text-[11.5px] text-emerald-700">→ {f.suggested}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </DialogContent>
        </Dialog>
      )}
      <HandoffChainDialog
        open={!!chainMessage}
        onClose={() => setChainMessage(null)}
        message={chainMessage}
        agents={agents}
      />
      <Toaster />
    </>
    </ErrorBoundary>
  );
}