import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useRef, useEffect, useMemo, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Message, Agent } from "@/types";
import { MessageItem } from "./MessageItem";
import { StreamingCards, type StreamingCardData } from "./StreamingCards";

type Props = {
  messages: Message[];
  agents: Agent[];
  roomId?: string;
  onReply?: (text: string, targetAgentName: string) => void;
  onShowChain?: (message: Message) => void;
  onDeleteMessage?: (message: Message) => void;
  /** live run cards rendered after the last message (parallel-safe, runId-keyed) */
  streamingCards?: StreamingCardData[];
};

export function MessageList({
  messages, agents, roomId, onReply, onShowChain, onDeleteMessage, streamingCards = [],
}: Props) {
  const ref = useRef<VirtuosoHandle>(null);
  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  const [atBottom, setAtBottom] = useState(true);
  // Mirror atBottom into a ref so the growth effect reads the live value.
  const atBottomRef = useRef(atBottom);
  atBottomRef.current = atBottom;
  const prevLenRef = useRef(messages.length);

  // Instant jump. Smooth scrolling over a long virtualized list walks every
  // intermediate viewport ("pulls and loads" the whole way down) — that is
  // what made the button feel stuck on long threads.
  const scrollToBottom = () => {
    if (messages.length === 0) return;
    ref.current?.scrollToIndex({
      index: messages.length - 1,
      align: "end",
      behavior: "auto",
    });
  };

  useEffect(() => {
    const prev = prevLenRef.current;
    prevLenRef.current = messages.length;
    if (messages.length === 0) return;
    // A big jump (initial load / room switch / history growth) always snaps;
    // a small increment only follows the reader when they're already at the
    // bottom — never yank someone who scrolled up (that's the button's job).
    const jumped = prev === 0 || messages.length - prev > 5;
    if (!jumped && !atBottomRef.current) return;
    ref.current?.scrollToIndex({
      index: messages.length - 1,
      align: "end",
      behavior: jumped ? "auto" : "smooth",
    });
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
      className="flex-1 min-h-0 bg-white relative flex flex-col"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
    >
      <Virtuoso
        ref={ref}
        data={messages}
        followOutput="smooth"
        increaseViewportBy={600}
        atBottomThreshold={120}
        atBottomStateChange={setAtBottom}
        itemContent={(index, msg) => {
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
              onDelete={onDeleteMessage}
            />
          );
        }}
        components={{
          Footer: () => (
            <div className="h-2">
              {streamingCards.length > 0 && <StreamingCards cards={streamingCards} />}
            </div>
          ),
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
