import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Settings, MoreHorizontal, Trash2, ScanSearch, Download, Users, Repeat2,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { Agent, Room } from "@/types";
import { cn } from "@/lib/utils";

type Props = {
  room: Room;
  agents: Agent[];
  selfTalkEnabled: boolean;
  activeAgentIds?: string[];
  onToggleSelfTalk: () => void;
  onReview: () => void;
  onExport: () => void;
  onClear: () => void;
  onDelete: () => void;
  onSettings: () => void;
  onInvite: () => void;
};

export function RoomHeader({
  room, agents, selfTalkEnabled, activeAgentIds = [],
  onToggleSelfTalk, onReview, onExport, onClear, onDelete, onSettings, onInvite,
}: Props) {
  const roomAgents = agents.filter(a => room.agentIds.includes(a.id));
  const visible = roomAgents.slice(0, 5);
  const overflow = Math.max(0, roomAgents.length - visible.length);
  const activeSet = new Set(activeAgentIds);

  return (
    <div className="h-14 px-4 py-2.5 border-b border-zinc-200/80 bg-white flex items-center gap-3 shrink-0">
      {/* room identity */}
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white text-xs font-bold shrink-0 shadow-sm shadow-indigo-200/50">
          {room.name.slice(0, 1).toUpperCase() || "#"}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold text-foreground truncate">
              {room.name}
            </h2>
            {room.status === "self-talk" && (
              <span className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-full bg-amber-50 border border-amber-200 text-[10px] font-medium text-amber-700 shrink-0">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                Self-Talk
              </span>
            )}
          </div>
          {room.topic && (
            <p
              onClick={() => { /* wired up in App.tsx */ }}
              title={room.topic}
              className="text-[11.5px] text-muted-foreground truncate max-w-md cursor-pointer hover:text-foreground transition-colors"
            >
              {room.topic}
            </p>
          )}
        </div>
      </div>

      {/* agent avatar stack */}
      <div className="flex items-center pl-2">
        {visible.map((a, idx) => {
          const isActive = activeSet.has(a.id);
          return (
            <div
              key={a.id}
              className="relative -ml-1.5 first:ml-0 group"
              style={{ zIndex: visible.length - idx }}
              title={`${a.name} · ${a.role}`}
            >
              <div
                className={cn(
                  "h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-white ring-2 ring-white transition-transform group-hover:scale-110",
                  isActive && "agent-pulse"
                )}
                style={{ background: a.color, color: a.color }}
              >
                {a.name.slice(0, 1).toUpperCase()}
              </div>
              <span
                className={cn(
                  "absolute bottom-0 right-0 h-2 w-2 rounded-full ring-2 ring-white",
                  a.status === "online" && "bg-emerald-500",
                  a.status === "busy" && "bg-amber-500",
                  a.status === "offline" && "bg-zinc-400",
                  a.status === "idle" && "bg-sky-500"
                )}
              />
            </div>
          );
        })}
        {overflow > 0 && (
          <div className="-ml-1.5 h-6 w-6 rounded-full bg-zinc-100 ring-2 ring-white flex items-center justify-center text-[9px] font-semibold text-zinc-600">
            +{overflow}
          </div>
        )}
      </div>

      {/* activity status */}
      {activeAgentIds.length > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-600 shrink-0">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
          {activeAgentIds.length} thinking
        </div>
      )}

      <div className="flex-1" />

      {/* actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        <Button
          size="sm"
          onClick={onToggleSelfTalk}
          className={cn(
            "h-7 px-2.5 text-[11px] gap-1.5 border",
            selfTalkEnabled
              ? "bg-amber-500 hover:bg-amber-600 text-white border-amber-500 shadow-sm shadow-amber-200/60"
              : "bg-white border-zinc-200 text-zinc-700 hover:bg-zinc-50"
          )}
        >
          <Repeat2 className="h-3 w-3" />
          Self-Talk
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onReview}
          className="h-7 px-2.5 text-[11px] gap-1.5 border-zinc-200"
        >
          <ScanSearch className="h-3 w-3" />
          Review
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onSettings}
          className="h-7 w-7 text-zinc-500 hover:text-zinc-700"
          title="Room settings"
        >
          <Settings className="h-3.5 w-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-zinc-500 hover:text-zinc-700"
              title="More actions"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={onExport} className="text-[12px]">
              <Download className="h-3.5 w-3.5 mr-2" /> Export
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onInvite} className="text-[12px]">
              <Users className="h-3.5 w-3.5 mr-2" /> Members
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onClear} className="text-[12px]">
              <Trash2 className="h-3.5 w-3.5 mr-2" /> Clear messages
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDelete}
              className="text-[12px] text-red-600 focus:text-red-700"
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete room
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}