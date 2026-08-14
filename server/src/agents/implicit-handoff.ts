/**
 * implicit-handoff.ts — Echo fallback builder.
 *
 * All implicit tag-based routing rules have been removed. The system no longer
 * evaluates hardcoded rules like "Forge [RESULT] → Lens" or "Scout [RESEARCH]
 * → Atlas". Instead, every agent is expected to produce an explicit ```handoff```
 * block when it wants to route to another agent. If no handoff is present, the
 * chain ends naturally.
 *
 * The only remaining function is buildEchoFallback, which builds a handoff
 * directive to Echo for schema validation failures (when the invoker's handoff
 * explicitly sets failurePolicy.onInvalidOutput = "fallback_echo").
 */

import { nanoid } from "nanoid";
import type { HandoffDirectiveV2, OutputSchema } from "./handoff.js";

export type AgentId = string;

/**
 * Build a handoff directive to Echo for the fallback chain.
 * Used by the trigger loop when validateOutputAgainstSchema() returns
 * false on a handoff with requiredOutputSchema set.
 */
export function buildEchoFallback(opts: {
  from: AgentId;
  parentTraceId: string;
  parentContent: string;
  expectedSchema: OutputSchema;
  originalTaskSummary?: string;
  /** "schema" (invalid output) or "timeout" (run failure) — drives wording */
  failureType?: "schema" | "timeout";
}): HandoffDirectiveV2 {
  const truncated = opts.parentContent.length > 1500
    ? opts.parentContent.slice(0, 1500) + "..."
    : opts.parentContent;
  const cause =
    opts.failureType === "timeout"
      ? "运行超时/进程失败，未产出有效输出"
      : `未能产出 requiredOutputSchema="${opts.expectedSchema}" 的有效输出`;
  const fallbackSummary =
    `兜底接管: 上游 agent "${opts.from}" 在 handoff chain ` +
    `(traceId=${opts.parentTraceId}) 中${cause}。` +
    (opts.originalTaskSummary ? `\n\n原任务: ${opts.originalTaskSummary}` : "") +
    `\n\n请接管这个任务，按"${opts.expectedSchema}"要求产出回复。若信息不足无法处理，输出 [BLOCKER] 让用户介入。`;

  return {
    schemaVersion: "2.0",
    traceId: nanoid(),
    rawTraceId: opts.parentTraceId,
    to: [{ id: "echo", name: "Echo", rawName: "echo" }],
    taskSummary: fallbackSummary,
    requiredOutputSchema: opts.expectedSchema,
    failurePolicy: { onInvalidOutput: "escalate", onTimeout: "fallback_echo", maxRetries: 0 },
    provenance: { parentAgent: opts.from, parentMessageId: opts.parentTraceId },
  };
}