import { Search, Bell, MoreHorizontal, Sparkles } from "lucide-react";
import type { WsStatus } from "@/lib/ws";
import type { Agent } from "@/types";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Props = {
  wsStatus: WsStatus;
  onOpenPalette: () => void;
  agents?: Agent[];
  activeAgentIds?: string[];
  roomName?: string;
  unread?: number;
  title?: string;
};

const MAX_AVATARS = 4;

type StatusKind = "connected" | "connecting" | "disconnected";

const STATUS: Record<StatusKind, { label: string; dot: string; ring: string }> = {
  connected: {
    label: "Connected",
    dot: "bg-emerald-500",
    ring: "bg-emerald-500/40",
  },
  connecting: {
    label: "Reconnecting",
    dot: "bg-amber-500",
    ring: "bg-amber-500/40",
  },
  disconnected: {
    label: "Disconnected",
    dot: "bg-red-500",
    ring: "bg-red-500/40",
  },
};

function StatusPill({ status }: { status: WsStatus }) {
  const cfg = STATUS[status];
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] leading-none text-muted-foreground">
      <span className="relative flex h-2 w-2">
        {status === "connecting" && (
          <span
            className={cn(
              "absolute inset-0 animate-ping rounded-full",
              cfg.ring
            )}
          />
        )}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full ring-2 ring-background",
            cfg.dot
          )}
        />
      </span>
      <span>{cfg.label}</span>
    </div>
  );
}

function AgentAvatar({ agent, active }: { agent: Agent; active: boolean }) {
  const color = agent.color || "#6366f1";
  const initial = agent.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      style={{ backgroundColor: color, color }}
      className={cn(
        "relative flex h-6 w-6 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold",
        active && "agent-pulse"
      )}
    >
      {agent.avatar ? (
        <img
          src={agent.avatar}
          alt={agent.name}
          className="h-full w-full rounded-full object-cover"
          style={{ color: "white" }}
        />
      ) : (
        <span style={{ color: "#fff" }}>{initial}</span>
      )}
    </div>
  );
}

export function TopBar({
  wsStatus,
  onOpenPalette,
  agents = [],
  activeAgentIds = [],
  roomName,
  unread = 0,
}: Props) {
  const visible = agents.slice(0, MAX_AVATARS);
  const overflow = agents.length - visible.length;
  const thinking = agents.filter((a) => activeAgentIds.includes(a.id)).length;
  const tooltipText = `${agents.length} agent${agents.length === 1 ? "" : "s"} · ${thinking} thinking`;

  return (
    <div className="flex h-12 items-center gap-3 border-b border-border bg-background px-3">
      {/* Brand chip */}
      <div className="flex items-center gap-2 pr-1">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 via-indigo-500 to-violet-600 shadow-sm ring-1 ring-black/5">
          <Sparkles className="h-4 w-4 text-white" strokeWidth={2.25} />
        </div>
        <div className="flex flex-col leading-none">
          <span className="text-sm font-semibold tracking-tight text-foreground">
            Atelier
          </span>
          <StatusPill status={wsStatus} />
        </div>
      </div>

      {/* Room name (optional context) */}
      {roomName && (
        <div className="hidden min-w-0 items-center text-sm text-muted-foreground md:flex">
          <span className="mr-2 text-border">|</span>
          <span className="max-w-[220px] truncate">· {roomName}</span>
        </div>
      )}

      <div className="flex-1" />

      {/* Agent live counter */}
      {agents.length > 0 && (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="flex items-center -space-x-1.5 pr-1"
                aria-label={tooltipText}
              >
                {visible.map((agent) => (
                  <AgentAvatar
                    key={agent.id}
                    agent={agent}
                    active={activeAgentIds.includes(agent.id)}
                  />
                ))}
                {overflow > 0 && (
                  <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-medium text-muted-foreground">
                    +{overflow}
                  </div>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">{tooltipText}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Command palette trigger (Linear-style) */}
      <button
        type="button"
        onClick={onOpenPalette}
        className="group flex h-7 w-[260px] items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Open command palette"
      >
        <Search className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate text-left">
          Search or run a command…
        </span>
        <kbd className="hidden shrink-0 rounded border border-border bg-background px-1.5 py-[1px] font-mono text-[10px] font-medium text-muted-foreground shadow-[0_1px_0_rgba(0,0,0,0.04)] sm:inline-block">
          ⌘K
        </kbd>
      </button>

      {/* Notification bell */}
      <button
        type="button"
        className="relative flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={unread > 0 ? `${unread} unread notifications` : "Notifications"}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-red-500 ring-2 ring-background" />
        )}
      </button>

      {/* Overflow menu */}
      <button
        type="button"
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="More options"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
    </div>
  );
}