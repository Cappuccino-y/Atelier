import { useState, useEffect, useMemo } from "react";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { RightPanel } from "./RightPanel";
import { CommandBar } from "./SearchPalette";
import { MessageList } from "@/components/chat/MessageList";
import { Composer } from "@/components/chat/Composer";
import { RoomHeader } from "@/components/chat/RoomHeader";
import type {
  Agent, Message, Room, Project, Task, Finding, Event, ActivityEvent,
} from "@/types";
import type { WsStatus } from "@/lib/ws";
import { cn } from "@/lib/utils";

type Props = {
  rooms: Room[];
  projects: Project[];
  agents: Agent[];
  currentRoom?: Room;
  messages: Message[];
  streamingText: Record<string, string>;
  streamingTool: Record<string, string>;
  tasks: Task[];
  events: Event[];
  findings: Finding[];
  activities: ActivityEvent[];
  streamingAgent?: Agent | null;
  wsStatus: WsStatus;
  showRightPanel: boolean;
  onSelectRoom: (id: string) => void;
  onCreateRoom: () => void;
  onSendMessage: (content: string, mentionedIds: string[]) => void;
  onToggleSelfTalk: () => void;
  onReview: () => void;
  onExport: () => void;
  onClearRoom: () => void;
  onDeleteRoom: () => void;
  onRoomSettings: () => void;
  onInvite: () => void;
  onCreateTask: (title: string) => void;
  onUpdateTask: (id: string, patch: Partial<Task>) => void;
  onDeleteTask: (id: string) => void;
  onSaveNotes: (notes: string) => void;
  onStopStreaming: () => void;
  onStopAll: () => void;
  onToggleRightPanel: () => void;
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
  const flatFindings: Finding[] = useMemoFlatFindings(allMessages);

  const activeAgentIds = useMemo(() => {
    if (!props.currentRoom) return [];
    const ids = new Set<string>();
    // Scope to the current room — App-level activity state receives events
    // from every room and would otherwise leak across rooms.
    // Walk events chronologically so a normal thinking → completed/errored
    // sequence leaves the agent in the correct final state. Descending order
    // would let an older thinking event re-add an agent after a newer
    // completion.
    const sorted = props.activities
      .filter(a => a.roomId === props.currentRoom!.id)
      .sort((a, b) => a.timestamp - b.timestamp);
    for (const ev of sorted) {
      if (!ev.agentId) continue;
      if (ev.kind === "agent.thinking") {
        ids.add(ev.agentId);
      } else if (ev.kind === "agent.completed" || ev.kind === "agent.error") {
        ids.delete(ev.agentId);
      }
    }
    return Array.from(ids);
  }, [props.activities, props.currentRoom]);

  const unreadRooms = props.rooms.filter(r => r.unread > 0).length;

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
        />
        <main className="flex-1 flex flex-col min-w-0">
          {props.currentRoom ? (
            <>
              <RoomHeader
                room={props.currentRoom}
                agents={props.agents}
                selfTalkEnabled={selfTalkEnabled}
                activeAgentIds={activeAgentIds}
                onToggleSelfTalk={() => { setSelfTalkEnabled(v => !v); props.onToggleSelfTalk(); }}
                onReview={props.onReview}
                onExport={props.onExport}
                onClear={props.onClearRoom}
                onDelete={props.onDeleteRoom}
                onSettings={props.onRoomSettings}
                onInvite={props.onInvite}
              />
              <MessageList
                messages={allMessages}
                agents={props.agents}
                streamingAgent={props.streamingAgent}
                streamingText={props.streamingText}
                streamingTool={props.streamingTool}
                onStopStreaming={props.onStopStreaming}
              />
              <Composer agents={props.agents} onSend={props.onSendMessage} />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              Select or create a room to start
            </div>
          )}
        </main>
        {props.showRightPanel && props.currentRoom && (
          <RightPanel
            room={props.currentRoom}
            tasks={props.tasks}
            messages={allMessages}
            findings={flatFindings}
            events={props.events}
            activities={props.activities}
            agents={props.agents}
            onCreateTask={props.onCreateTask}
            onUpdateTask={props.onUpdateTask}
            onDeleteTask={props.onDeleteTask}
            onSaveNotes={props.onSaveNotes}
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

function useMemoFlatFindings(messages: Message[]): Finding[] {
  const out: Finding[] = [];
  for (const m of messages) {
    if (m.findings) out.push(...m.findings);
  }
  return out;
}