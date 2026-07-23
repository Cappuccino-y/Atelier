export type Agent = {
  id: string;
  name: string;
  role: string;
  color: string;
  avatar?: string;
  model?: string;
  status: "online" | "offline" | "busy" | "idle";
  lastSeen?: number;
};

export type Message = {
  id: string;
  roomId: string;
  authorId: string;
  content: string;
  tags?: string[];
  findings?: Finding[] | null;
  parentId?: string | null;
  mentionedAgentIds?: string[];
  timestamp: number;
};

export type Room = {
  id: string;
  name: string;
  topic?: string;
  status: "active" | "archived" | "self-talk";
  unread: number;
  lastActivity: number;
  agentIds: string[];
  notes?: string;
  createdAt: number;
  projectId?: string;
  mode?: "solo" | "on-demand" | "collaborative" | "self-talk";
  cap?: number;
};

export type Task = {
  id: string;
  roomId: string;
  title: string;
  assigneeId?: string;
  status: "todo" | "doing" | "blocked" | "done";
  createdAt: number;
};

export type Project = {
  id: string;
  name: string;
  roomIds: string[];
  createdAt: number;
};

export type Finding = {
  id?: string;
  severity: "critical" | "major" | "minor";
  title: string;
  location?: string;
  quote?: string;
  suggested?: string;
  supportingCritics?: string[];
};

/* ---- Live Activity feed ----------------------------------------------- */

export type ActivityKind =
  | "agent.thinking"
  | "agent.tool_call"
  | "agent.handoff"
  | "agent.completed"
  | "agent.error"
  | "task.created"
  | "task.updated"
  | "self_talk.tick";

export type ActivityEvent = {
  id: string;
  roomId: string;
  kind: ActivityKind;
  agentId?: string;
  message?: string;
  meta?: Record<string, unknown>;
  timestamp: number;
  /** optimistic — true if locally generated and waiting for confirmation */
  pending?: boolean;
};

export type Event = {
  id: string;
  roomId: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
};

export type AgentStatus = "online" | "offline" | "busy" | "idle";

export type ServerEvent =
  | "message.created"
  | "task.created"
  | "task.updated"
  | "task.deleted"
  | "room.created"
  | "room.updated"
  | "room.deleted"
  | "messages.cleared"
  | "project.updated"
  | "agent.created"
  | "agent.updated"
  | "agent.status"
  | "self_talk.start"
  | "self_talk.stop"
  | "self_talk.tick"
  | "escalation"
  | "rework"
  | "finding.accepted"
  | "finding.rejected"
  | "system.warning"
  | "system.info"
  | "system.error"
  | "routing.route"
  | "routing.invite"
  | "ping"
  | "pong"
  | "review.completed"
  | "agent.thinking"
  | "agent.tool_call"
  | "agent.text_delta"
  | "agent.step_done"
  | "agent.handoff"
  | "agent.completed"
  | "agent.error"
  | "activity.cleared";

/* ---- Command palette -------------------------------------------------- */

export type CommandItem = {
  id: string;
  kind: "room" | "message" | "task" | "command" | "agent";
  title: string;
  subtitle?: string;
  icon?: string;
  hint?: string;
  payload?: unknown;
  action?: () => void;
};