import { useState, type DragEvent } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Plus, MessageSquare, Folder, Archive, Trash2, ChevronDown, ChevronRight,
  FolderPlus,
} from "lucide-react";
import type { Room, Project } from "@/types";
import { cn, formatRelativeTime } from "@/lib/utils";

type Props = {
  rooms: Room[];
  projects: Project[];
  currentRoomId?: string;
  onSelectRoom: (id: string) => void;
  onCreateRoom: () => void;
  onDeleteRoom: (id: string) => void;
  onCreateProject: (name: string) => void;
  onDeleteProject: (id: string, name: string) => void;
  onMoveRoom: (roomId: string, projectId: string | null) => void;
};

export function Sidebar({
  rooms, projects, currentRoomId, onSelectRoom, onCreateRoom, onDeleteRoom,
  onCreateProject, onDeleteProject, onMoveRoom,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [projectInput, setProjectInput] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [dragOver, setDragOver] = useState<string | null>(null);

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

  function handleDragStart(e: DragEvent, roomId: string) {
    e.dataTransfer.setData("text/plain", roomId);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e: DragEvent, projectId: string | null) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(projectId);
  }

  function handleDragLeave() {
    setDragOver(null);
  }

  function handleDrop(e: DragEvent, projectId: string | null) {
    e.preventDefault();
    setDragOver(null);
    const roomId = e.dataTransfer.getData("text/plain");
    if (roomId) onMoveRoom(roomId, projectId);
  }

  function renderRoomItem(room: Room) {
    const active = currentRoomId === room.id;
    return (
      <div
        key={room.id}
        draggable
        onDragStart={e => handleDragStart(e, room.id)}
        className={cn(
          "group flex items-center gap-0.5 rounded-md transition-colors",
          active && "bg-accent"
        )}
      >
        <button
          onClick={() => onSelectRoom(room.id)}
          className="flex-1 min-w-0 text-left px-2 py-1.5 flex items-start gap-2 text-sm"
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
        <button
          onClick={() => onDeleteRoom(room.id)}
          className="h-7 w-7 mr-1 flex items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-500 transition-all shrink-0"
          title="Delete room"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  function renderGroup(p: Project) {
    const list = roomsByProject.get(p.id) ?? [];
    const isCollapsed = collapsed[p.id] ?? false;
    const isOver = dragOver === p.id;
    return (
      <div key={p.id}>
        <div
          onDragOver={e => handleDragOver(e, p.id)}
          onDragLeave={handleDragLeave}
          onDrop={e => handleDrop(e, p.id)}
          className={cn(
            "group flex items-center gap-1 px-2 py-1 text-xs font-semibold text-muted-foreground rounded transition-colors",
            isOver && "bg-accent ring-1 ring-primary/30"
          )}
        >
          <button
            onClick={() => setCollapsed(prev => ({ ...prev, [p.id]: !isCollapsed }))}
            className="h-4 w-4 flex items-center justify-center shrink-0 hover:text-foreground"
          >
            {isCollapsed
              ? <ChevronRight className="h-3 w-3" />
              : <ChevronDown className="h-3 w-3" />
            }
          </button>
          <Folder className="h-3 w-3 shrink-0" />
          <span className="flex-1 truncate">{p.name}</span>
          <span className="text-[10px] tabular-nums opacity-60">{list.length}</span>
          <button
            onClick={() => onDeleteProject(p.id, p.name)}
            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-500 transition-all shrink-0"
            title="Delete group"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
        {!isCollapsed && <div className="ml-2">{list.map(renderRoomItem)}</div>}
      </div>
    );
  }

  return (
    <aside className="w-64 border-r bg-background flex flex-col">
      <div className="p-3 border-b flex items-center justify-between">
        <span className="font-semibold text-sm">Rooms</span>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={() => setProjectInput(true)} title="Create group">
            <FolderPlus className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={onCreateRoom}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {projectInput && (
        <div className="px-3 py-2 border-b">
          <div className="flex gap-1">
            <input
              autoFocus
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              placeholder="Group name…"
              className="flex-1 h-7 text-xs px-2 rounded border border-border bg-background"
              onKeyDown={e => {
                if (e.key === "Enter" && projectName.trim()) {
                  onCreateProject(projectName.trim());
                  setProjectName("");
                  setProjectInput(false);
                }
                if (e.key === "Escape") {
                  setProjectInput(false);
                  setProjectName("");
                }
              }}
            />
            <Button
              size="icon"
              className="h-7 w-7 shrink-0"
              disabled={!projectName.trim()}
              onClick={() => {
                onCreateProject(projectName.trim());
                setProjectName("");
                setProjectInput(false);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-3">
          {projects.map(renderGroup)}
          {orphan.length > 0 && (
            <div>
              <div
                onDragOver={e => handleDragOver(e, null)}
                onDragLeave={handleDragLeave}
                onDrop={e => handleDrop(e, null)}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 text-xs font-semibold text-muted-foreground rounded transition-colors",
                  dragOver === null && "bg-accent ring-1 ring-primary/30"
                )}
              >
                <Folder className="h-3 w-3" />
                Ungrouped
                <span className="text-[10px] tabular-nums opacity-60 ml-auto">{orphan.length}</span>
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