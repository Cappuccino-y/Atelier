import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useRef, useEffect, useMemo, useState } from "react";
import { ArrowDown, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Message, Agent } from "@/types";
import { MessageItem } from "./MessageItem";

type Props = {
  messages: Message[];
  agents: Agent[];
  roomId?: string;
  streamingAgent?: Agent | null;
  streamingText?: Record<string, string>;
  streamingTool?: Record<string, string>;
  onStopStreaming?: () => void;
  onReply?: (text: string, targetAgentName: string) => void;
  onShowChain?: (message: Message) => void;
};

/** Inline pseudo-message rendered while an agent streams. */
function StreamingMessageItem({ agent, text, tool, onStop }: {
  agent: Agent;
  text?: string;
  tool?: string;
  onStop?: () => void;
}) {
  const hasText = Boolean(text && text.length > 0);
  return (
    <div className="group relative flex gap-3 px-4 pt-3 pb-1" data-testid="streaming-message">
      <div className="w-9 shrink-0">
        <div
          className="h-9 w-9 rounded-full flex items-center justify-center text-xs font-semibold text-white ring-2 ring-white shadow-sm agent-pulse"
          style={{ background: agent.color, color: agent.color }}
        >
          {agent.name.slice(0, 2).toUpperCase()}
        </div>
      </div>
      <div className="flex flex-col items-start flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-[13px] font-semibold text-zinc-900">{agent.name}</span>
          {agent.role && <span className="text-[11px] text-zinc-500">{agent.role}</span>}
          {tool ? (
            <span className="flex items-center gap-1 text-[11px] text-zinc-400">
              running
              <code className="text-[10.5px] px-1.5 py-0.5 rounded bg-zinc-100 border border-zinc-200 text-zinc-600 font-mono max-w-[220px] truncate">
                {tool}
              </code>
            </span>
          ) : !hasText ? (
            <span className="flex items-center gap-2 text-[11px] text-zinc-400">
              is thinking
              <span className="flex items-center gap-1">
                <span className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-zinc-400" />
                <span className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-zinc-400" />
                <span className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-zinc-400" />
              </span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-indigo-500">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500 animate-pulse" />
              streaming
            </span>
          )}
        </div>
        <div
          className={cn(
            "relative w-full break-words rounded-lg border border-dashed border-indigo-200 bg-indigo-50/30 px-3 py-2",
            !hasText && "hidden"
          )}
        >
          <div className="prose-chat text-[13.5px] leading-relaxed text-zinc-700 whitespace-pre-wrap break-words">
            {text}
            <span className="inline-block w-1.5 h-3.5 bg-indigo-400 ml-0.5 align-middle animate-pulse rounded-sm" />
          </div>
        </div>
        {onStop && (
          <Button
            variant="outline"
            size="sm"
            onClick={onStop}
            className="mt-1.5 h-6 px-2.5 text-[11px] rounded-full border-zinc-200 text-zinc-600 hover:bg-red-50 hover:border-red-200 hover:text-red-700"
            title="Stop generating"
          >
            <Square className="h-2.5 w-2.5 mr-1 fill-current" />
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}

export function MessageList({
  messages, agents, roomId, streamingAgent = null,
  streamingText = {}, streamingTool = {}, onStopStreaming,
  onReply, onShowChain,
}: Props) {
  const ref = useRef<VirtuosoHandle>(null);
  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  const [atBottom, setAtBottom] = useState(true);

  // Streaming keys are `${roomId}:${agentId}` so parallel rooms never share
  // or clobber each other's in-flight text (see App.tsx stream buffers).
  const streamKey = streamingAgent && roomId ? `${roomId}:${streamingAgent.id}` : undefined;
  const streamText = streamKey ? streamingText[streamKey] : undefined;
  const streamToolName = streamKey ? streamingTool[streamKey] : undefined;

  // Streaming renders as the LAST list item so it grows in place inside the
  // conversation instead of in a detached box pinned to the composer.
  const items = useMemo(() => {
    if (!streamingAgent) return messages;
    return [...messages, "STREAMING" as const];
  }, [messages, streamingAgent]);

  const scrollToBottom = () => {
    if (items.length === 0) return;
    ref.current?.scrollToIndex({
      index: items.length - 1,
      align: "end",
      behavior: "smooth",
    });
  };

  useEffect(() => {
    if (items.length > 0) {
      ref.current?.scrollToIndex({
        index: items.length - 1,
        align: "end",
        behavior: "smooth",
      });
    }
  }, [items.length]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gradient-to-b from-white to-zinc-50/50">
        <div className="text-center max-w-sm px-6">
          <h3 className="text-base font-semibold text-zinc-900 mb-2">Start the conversation</h3>
          <p className="text-[13px] text-zinc-500 leading-relaxed mb-5">
            Mention an agent with{" "}
            <kbd className="px-1 py-0.5 rounded bg-zinc-100 border border-zinc-200 font-mono text-[11px]">@</kbd>{" "}
            to invite them. They'll read the room context and respond.
          </p>
          <div className="flex flex-wrap justify-center gap-1.5 mb-5">
            {[
              { name: "Atlas", role: "orchestrator" },
              { name: "Forge", role: "implementer" },
              { name: "Lens", role: "reviewer" },
              { name: "Echo", role: "support" },
            ].map((a) => (
              <span
                key={a.name}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white border border-dashed border-zinc-300 text-[12px] text-zinc-600"
              >
                <span className="text-zinc-400 font-mono">@</span>
                <span className="font-medium text-zinc-700">{a.name}</span>
                <span className="text-zinc-300">·</span>
                <span className="text-zinc-500">{a.role}</span>
              </span>
            ))}
          </div>
          <div className="text-[11px] text-zinc-400 inline-flex items-center gap-1.5">
            <kbd className="px-1.5 py-0.5 rounded bg-zinc-100 border border-zinc-200 font-mono text-[10px]">⌘K</kbd>
            <span>for commands</span>
          </div>
        </div>
      </div>
    );
  }

return (
    <div
      className="flex-1 min-h-0 bg-white relative flex flex-col"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
    >
      <Virtuoso
        ref={ref}
        data={items}
        followOutput="smooth"
        increaseViewportBy={200}
        atBottomStateChange={setAtBottom}
        itemContent={(index, item) => {
          if (item === "STREAMING" && streamingAgent) {
            return (
              <StreamingMessageItem
                agent={streamingAgent}
                text={streamText}
                tool={streamToolName}
                onStop={onStopStreaming}
              />
            );
          }
          const msg = item as Message;
          const author = agentMap.get(msg.authorId);
          const mentionedAgents = (msg.mentionedAgentIds ?? [])
            .map(id => agentMap.get(id))
            .filter((a): a is Agent => Boolean(a));
          const prev = messages[index - 1];
          const isGrouped = Boolean(
            prev &&
              prev.authorId === msg.authorId &&
              msg.timestamp - prev.timestamp < 120_000,
          );
          return (
            <MessageItem
              message={msg}
              author={author}
              mentionedAgents={mentionedAgents}
              isGrouped={isGrouped}
              index={index}
              onReply={onReply}
              onShowChain={onShowChain}
            />
          );
        }}
        components={{
          Footer: () => <div className="h-2" />,
        }}
        className="flex-1 min-h-0"
      />

      {!atBottom && (
        <div className="absolute bottom-4 right-4 z-10 animate-slide-up">
          <Button
            variant="outline"
            size="sm"
            onClick={scrollToBottom}
            className="rounded-full bg-white/95 backdrop-blur border border-zinc-200 shadow-lg ring-1 ring-black/5 px-3 py-1.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900"
          >
            <ArrowDown className="h-3 w-3 mr-1" />
            New messages
          </Button>
        </div>
      )}
    </div>
  );
}
