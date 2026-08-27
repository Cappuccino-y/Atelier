import type { Agent, Message, Room, Task, Project, Event, Finding, MemoryEntry, ActivityEvent } from "@/types";

const API_BASE = (import.meta.env.VITE_API_URL as string) || "http://127.0.0.1:8787";

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`API ${status}: ${body}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const headers: Record<string, string> = {
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json() as Promise<T>;
}

export const api = {
  listRooms: () => request<Room[]>("/api/rooms"),
  getRoom: (id: string) => request<Room>(`/api/rooms/${id}`),
  createRoom: (body: { name: string; topic?: string; projectId?: string }) =>
    request<Room>("/api/rooms", { method: "POST", body: JSON.stringify(body) }),
  updateRoom: (id: string, body: Partial<Room>) =>
    request<Room>(`/api/rooms/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteRoom: (id: string) => request<{ ok: true }>(`/api/rooms/${id}`, { method: "DELETE" }),
  clearRoomMessages: (id: string) =>
    request<{ ok: true }>(`/api/rooms/${id}/clear`, { method: "POST" }),
  listProjects: () => request<Project[]>("/api/projects"),
  createProject: (name: string) =>
    request<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),
  deleteProject: (id: string) => request<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE" }),
  moveRoom: (roomId: string, projectId: string | null) =>
    request<Room>(`/api/rooms/${roomId}`, { method: "PATCH", body: JSON.stringify({ projectId }) }),

  listMessages: (roomId: string) => request<Message[]>(`/api/rooms/${roomId}/messages`),
  sendMessage: (roomId: string, body: { content: string; authorId?: string; mentionedAgentIds?: string[] }) =>
    request<Message>(`/api/rooms/${roomId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  toggleReaction: (roomId: string, messageId: string, emoji: string) =>
    request<Message>(`/api/rooms/${roomId}/messages/${messageId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji }),
    }),
  decideFinding: (
    roomId: string,
    messageId: string,
    index: number | "all",
    decision: "accepted" | "rejected",
  ) =>
    request<Message>(`/api/rooms/${roomId}/messages/${messageId}/findings`, {
      method: "PATCH",
      body: JSON.stringify({ index, decision }),
    }),

  handoffChain: (messageId: string) =>
    request<{
      messageId: string;
      depth: number;
      chain: Array<{
        messageId: string;
        parentId: string | null;
        authorId: string;
        content: string;
        tags: string[];
        timestamp: number;
        handoffSummary?: string;
      }>;
    }>(`/api/runtime/handoff-chain/${messageId}`),

  listTasks: (roomId: string) => request<Task[]>(`/api/rooms/${roomId}/tasks`),
  createTask: (
    roomId: string,
    body: { title: string; assigneeId?: string; status?: string },
  ) =>
    request<Task>(`/api/rooms/${roomId}/tasks`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateTask: (id: string, body: Partial<Task>) =>
    request<Task>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteTask: (id: string) => request<{ ok: true }>(`/api/tasks/${id}`, { method: "DELETE" }),

  listAgents: () => request<Agent[]>("/api/agents"),
  upsertAgent: (body: Partial<Agent> & { id: string; name: string }) =>
    request<Agent>("/api/agents", { method: "POST", body: JSON.stringify(body) }),
  updateAgentStatus: (id: string, status: string) =>
    request<Agent>(`/api/agents/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  listRoomEvents: (roomId: string) => request<Event[]>(`/api/rooms/${roomId}/events`),
  listEvents: () => request<Event[]>("/api/events"),
  listRoomActivities: (roomId: string) =>
    request<ActivityEvent[]>(`/api/rooms/${roomId}/activities`),
  listRoomMemory: (roomId: string) =>
    request<{ count: number; entries: MemoryEntry[] }>(`/api/memory/list?scope=room:${roomId}`),

  reviewHealth: () => request<{ status: string }>("/api/review/health"),
  requestReview: (body: { document: string; panel?: string; context?: string }) =>
    request<{ findings: Finding[]; summary: string }>("/api/review", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  routeTo: (body: { roomId: string; agentId: string; content: string }) =>
    request<{ ok: true }>("/api/route-to", { method: "POST", body: JSON.stringify(body) }),
  inviteAgent: (body: { roomId: string; agentId: string }) =>
    request<{ ok: true }>("/api/invite", { method: "POST", body: JSON.stringify(body) }),
  selfTalkTick: (roomId: string) =>
    request<{ ok: true }>("/api/self-talk", {
      method: "POST",
      body: JSON.stringify({ roomId }),
    }),

  runtimeStatus: () => request<{ runtime: string; model: string }>("/api/runtime/status"),
  stopAgents: (body: { roomId?: string } = {}) =>
    request<{ ok: true; cancelled: number; roomId: string | null }>("/api/runtime/stop", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  stopAgent: (body: { roomId: string; agentId?: string; runId?: string }) =>
    request<{ ok: true; killed: number }>("/api/agents/stop", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  mcpRooms: () => request<{ rooms: Array<{ id: string; name: string }> }>("/mcp/rooms"),

  debugLog: (body: { level?: string; tag?: string; message: string; data?: unknown }) =>
    request<{ ok: true }>("/api/debug/log", { method: "POST", body: JSON.stringify(body) }),
};