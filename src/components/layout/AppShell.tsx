import { useState, useEffect, useMemo, useCallback } from "react";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { RightPanel } from "./RightPanel";
import { CommandBar } from "./SearchPalette";
import { MessageList } from "@/components/chat/MessageList";
import { Composer } from "@/components/chat/Composer";
import { RoomHeader } from "@/components/chat/RoomHeader";
import { RunningDock, type RunningRun } from "@/components/chat/RunningDock";
import type {
  Agent, Attachment, Message, Room, Project, Task, Event, ActivityEvent, MemoryEntry,
} from "@/types";
import type { WsStatus } from "@/lib/ws";

type Props = {
  rooms: Room[];
  projects: Project[];
  agents: Agent[];
  currentRoom?: Room;
  roomLoading?: boolean;
  roomLoadError?: string | null;
  messages: Message[];
  streamingText: Record<string, string>;
  streamingTool: Record<string, string>;
  tasks: Task[];
  events: Event[];
  activities: ActivityEvent[];
  runs: RunningRun[];
  wsStatus: WsStatus;
  showRightPanel: boolean;
  onSelectRoom: (id: string) => void;
  onCreateRoom: () => void;
  onSendMessage: (content: string, mentionedIds: string[], attachments?: Attachment[], interrupt?: boolean) => void;
  onToggleSelfTalk: () => void;
  onReview: () => void;
  onExport: () => void;
  onExportJson: () => void;
  onClearRoom: () => void;
  onDeleteRoom: (roomId?: string) => void;
  onRoomSettings: () => void;
  onInvite: () => void;
  onCreateTask: (title: string) => void;
  onUpdateTask: (id: string, patch: Partial<Task>) => void;
  onDeleteTask: (id: string) => void;
  onSaveNotes: (notes: string) => void;
  onStopAgent: (agentId: string) => void;
  onStopAll: () => void;
  onToggleRightPanel: () => void;
  onCreateProject: (name: string) => void;
  onDeleteProject: (id: string, name: string) => void;
  onMoveRoom: (roomId: string, projectId: string | null) => void;
  onShowChain: (message: Message) => void;
  onDeleteMessage: (message: Message) => void;
  memoryEntries: MemoryEntry[];
};

export function AppShell(props: Props) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selfTalkEnabled, setSelfTalkEnabled] = useState(false);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Cmd/Ctrl+K — open command palette
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // Cmd/Ctrl+\ — toggle right panel
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        props.onToggleRightPanel();
        return;
      }
      // Escape — close palette
      if (e.key === "Escape") {
        setPaletteOpen(false);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [props]);

  const allMessages = props.messages;

  // runs are derived in App (WS-driven, runId-granular) and survive refresh
  // via the REST activities rebuild
  const runningRuns = props.runs;

  const activeAgentIds = useMemo(
    () => Array.from(new Set(runningRuns.map(r => r.agent.id))),
    [runningRuns],
  );

  const unreadRooms = props.rooms.filter(r => r.unread > 0).length;

  // QuestionCard inline replies route through the normal send path so the
  // server's mention routing picks up the @target.
  const handleReply = useCallback(
    (content: string, _targetAgentName: string) => {
      props.onSendMessage(content, []);
    },
    [props.onSendMessage]
  );

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <TopBar
        wsStatus={props.wsStatus}
        onOpenPalette={() => setPaletteOpen(true)}
        agents={props.agents}
        activeAgentIds={activeAgentIds}
        roomName={props.currentRoom?.name}
        unread={unreadRooms}
      />
      <div className="flex flex-1 min-h-0">
        <Sidebar
          rooms={props.rooms}
          projects={props.projects}
          currentRoomId={props.currentRoom?.id}
          onSelectRoom={props.onSelectRoom}
          onCreateRoom={props.onCreateRoom}
          onDeleteRoom={props.onDeleteRoom}
          onCreateProject={props.onCreateProject}
          onDeleteProject={props.onDeleteProject}
          onMoveRoom={props.onMoveRoom}
        />
        <main className="flex-1 flex flex-col min-w-0">
          {props.currentRoom ? (
            <div className="flex-1 flex flex-col min-w-0">
              <RoomHeader
                room={props.currentRoom}
                agents={props.agents}
                selfTalkEnabled={selfTalkEnabled}
                activeAgentIds={activeAgentIds}
                onToggleSelfTalk={() => { setSelfTalkEnabled(v => !v); props.onToggleSelfTalk(); }}
                onReview={props.onReview}
                onExport={props.onExport}
                onExportJson={props.onExportJson}
                onClear={props.onClearRoom}
                onDelete={props.onDeleteRoom}
                onSettings={props.onRoomSettings}
                onInvite={props.onInvite}
              />
              <MessageList
                roomId={props.currentRoom?.id}
                messages={allMessages}
                agents={props.agents}
                onReply={handleReply}
                onShowChain={props.onShowChain}
                onDeleteMessage={props.onDeleteMessage}
              />
              <RunningDock
                runs={runningRuns}
                onStopAgent={props.onStopAgent}
                onStopAll={props.onStopAll}
              />              {props.roomLoading && (
                <div className="px-4 py-2 text-[12px] text-zinc-400 border-t border-zinc-200/80 bg-white">
                  Loading room data…
                </div>
              )}
              {props.roomLoadError && (
                <div className="px-4 py-2 text-[12px] text-red-600 border-t border-red-100 bg-red-50">
                  Failed to load room: {props.roomLoadError}
                </div>
              )}
              <Composer
                agents={props.agents}
                roomId={props.currentRoom?.id}
                onSend={props.onSendMessage}
                hasActiveRuns={runningRuns.length > 0}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              Select or create a room to start
            </div>
          )}
        </main>
        {props.showRightPanel && props.currentRoom && (
          <RightPanel
            room={props.currentRoom}
            activities={props.activities}
            agents={props.agents}
            memoryEntries={props.memoryEntries}
            tasks={props.tasks.filter(t => t.roomId === props.currentRoom!.id)}
            onCreateTask={props.onCreateTask}
            onUpdateTask={props.onUpdateTask}
            onDeleteTask={props.onDeleteTask}
            onStopAll={props.onStopAll}
          />
        )}
      </div>

      <CommandBar
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        rooms={props.rooms}
        messages={allMessages}
        tasks={props.tasks}
        agents={props.agents}
        onSelectRoom={props.onSelectRoom}
        onCreateRoom={props.onCreateRoom}
        onReview={props.onReview}
        onExport={props.onExport}
        onToggleSelfTalk={props.onToggleSelfTalk}
        onToggleRightPanel={props.onToggleRightPanel}
      />
    </div>
  );
}
