import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, MessageSquare, Folder, Archive } from "lucide-react";
import type { Room, Project } from "@/types";
import { cn, formatRelativeTime } from "@/lib/utils";

type Props = {
  rooms: Room[];
  projects: Project[];
  currentRoomId?: string;
  onSelectRoom: (id: string) => void;
  onCreateRoom: () => void;
};

export function Sidebar({ rooms, projects, currentRoomId, onSelectRoom, onCreateRoom }: Props) {
  const roomsByProject = new Map<string, Room[]>();
  const orphan: Room[] = [];
  const archived: Room[] = [];

  for (const r of rooms) {
    if (r.status === "archived") {
      archived.push(r);
      continue;
    }
    if (r.projectId) {
      const list = roomsByProject.get(r.projectId) ?? [];
      list.push(r);
      roomsByProject.set(r.projectId, list);
    } else {
      orphan.push(r);
    }
  }

  function renderRoomItem(room: Room) {
    const active = currentRoomId === room.id;
    return (
      <button
        key={room.id}
        onClick={() => onSelectRoom(room.id)}
        className={cn(
          "w-full text-left px-2 py-1.5 rounded-md flex items-start gap-2 text-sm hover:bg-accent transition-colors",
          active && "bg-accent"
        )}
      >
        <MessageSquare className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{room.name}</div>
          <div className="text-xs text-muted-foreground">{formatRelativeTime(room.lastActivity)}</div>
        </div>
        {room.unread > 0 && (
          <span className="bg-primary text-primary-foreground text-[10px] rounded-full px-1.5 h-4 flex items-center">
            {room.unread}
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="w-64 border-r bg-background flex flex-col">
      <div className="p-3 border-b flex items-center justify-between">
        <span className="font-semibold text-sm">Rooms</span>
        <Button size="icon" variant="ghost" onClick={onCreateRoom}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-3">
          {projects.map(p => {
            const list = roomsByProject.get(p.id) ?? [];
            return (
              <div key={p.id}>
                <div className="flex items-center gap-1 px-2 py-1 text-xs font-semibold text-muted-foreground">
                  <Folder className="h-3 w-3" />
                  {p.name}
                </div>
                <div className="ml-2">{list.map(renderRoomItem)}</div>
              </div>
            );
          })}
          {orphan.length > 0 && (
            <div>
              <div className="flex items-center gap-1 px-2 py-1 text-xs font-semibold text-muted-foreground">
                <Folder className="h-3 w-3" />
                Ungrouped
              </div>
              <div className="ml-2">{orphan.map(renderRoomItem)}</div>
            </div>
          )}
          {archived.length > 0 && (
            <div>
              <div className="flex items-center gap-1 px-2 py-1 text-xs font-semibold text-muted-foreground">
                <Archive className="h-3 w-3" />
                Archived
              </div>
              <div className="ml-2 opacity-60">{archived.map(renderRoomItem)}</div>
            </div>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
