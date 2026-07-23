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
  streamingAgent?: Agent | null;
  streamingText?: Record<string, string>;
  streamingTool?: Record<string, string>;
  onStopStreaming?: () => void;
};

function StreamingIndicator({ agent, text, tool, onStop }: {
  agent: Agent;
  text?: string;
  tool?: string;
  onStop?: () => void;
}) {
  const hasText = Boolean(text && text.length > 0);
  return (
    <div className="px-4 py-2 animate-message-in">
      <div className="flex items-center gap-3">
        <div
          className="h-8 w-8 rounded-full flex items-center justify-center text-[11px] font-semibold text-white ring-2 ring-white shadow-sm agent-pulse shrink-0"
          style={{ background: agent.color, color: agent.color }}
        >
          {agent.name.slice(0, 2).toUpperCase()}
        </div>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-[12.5px] font-medium text-zinc-700 truncate">{agent.name}</span>
          {tool ? (
            <>
              <span className="text-[11px] text-zinc-400">running tool</span>
              <code className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-100 border border-zinc-200 text-zinc-700 font-mono">
                {tool}
              </code>
            </>
          ) : !hasText ? (
            <>
              <span className="text-[11px] text-zinc-400">is thinking</span>
              <div className="flex items-center gap-1 ml-1">
                <span className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-zinc-400" />
                <span className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-zinc-400" />
                <span className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-zinc-400" />
              </div>
            </>
          ) : (
            <span className="text-[11px] text-zinc-400">streaming</span>
          )}
        </div>
        {onStop && (
          <Button
            variant="outline"
            size="sm"
            onClick={onStop}
            className="ml-auto h-7 px-2.5 text-[11px] rounded-full border-zinc-200 text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
            title="Stop generating"
          >
            <Square className="h-2.5 w-2.5 mr-1 fill-current" />
            Stop
          </Button>
        )}
      </div>
      {hasText && (
        <div className="mt-2 ml-11 text-[13px] leading-relaxed text-zinc-700 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
          {text}
          <span className="inline-block w-1.5 h-3.5 bg-zinc-400 ml-0.5 align-middle animate-pulse" />
        </div>
      )}
    </div>
  );
}

export function MessageList({
  messages, agents, streamingAgent = null,
  streamingText = {}, streamingTool = {}, onStopStreaming,
}: Props) {
  const ref = useRef<VirtuosoHandle>(null);
  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToBottom = () => {
    if (messages.length === 0) return;
    ref.current?.scrollToIndex({
      index: messages.length - 1,
      align: "end",
      behavior: "smooth",
    });
  };

  useEffect(() => {
    if (messages.length > 0) {
      ref.current?.scrollToIndex({
        index: messages.length - 1,
        align: "end",
        behavior: "smooth",
      });
    }
  }, [messages.length]);

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
      className="flex-1 min-h-0 bg-white relative"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
    >
<Virtuoso
        ref={ref}
        data={messages}
        followOutput="smooth"
        increaseViewportBy={200}
        atBottomStateChange={setAtBottom}
        itemContent={(index, msg) => {
          const author = agentMap.get(msg.authorId);
          const mentionedAgents = (msg.mentionedAgentIds ?? [])
            .map((id) => agentMap.get(id))
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
            />
          );
        }}
        components={{
          Footer: () => (
            <div className={cn(streamingAgent && "pb-1")}>
              {streamingAgent && (
                <StreamingIndicator
                  agent={streamingAgent}
                  text={streamingText[streamingAgent.id]}
                  tool={streamingTool[streamingAgent.id]}
                  onStop={onStopStreaming}
                />
              )}
              <div className="h-8" />
            </div>
          ),
        }}
      />

      {!atBottom && (
        <div className="absolute bottom-4 right-4 z-10">
          <Button
            variant="outline"
            size="sm"
            onClick={scrollToBottom}
            className="rounded-full bg-white border border-zinc-200 shadow-md px-3 py-1.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900"
          >
            <ArrowDown className="h-3 w-3 mr-1" />
            New messages
          </Button>
        </div>
      )}
    </div>
  );
}
