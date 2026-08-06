/**
 * implicit-handoff.ts — Tag-based routing rules for Phase 2.
 *
 * Industry backing:
 *   - Anthropic: "Subagents facilitate compression by operating in parallel...
 *     exploring different prompts, exploration trajectories"
 *   - LangGraph Command(goto=): rules-based routing + dynamic supervisor
 *   - Magentic / AutoGen: "pattern matching on agent output for routing"
 *
 * Design principle: rules are data, not code. Each rule is a small record
 * with a `match` predicate (which (agent, tags, content) combinations
 * trigger it) and a `target` (where to route). Adding/removing a rule
 * doesn't require touching the trigger loop.
 *
 * The rules fall into three categories:
 *
 *   1. defaultContinue — what happens after a successful tag emission
 *      (e.g. [RESULT] from Forge → Lens review, all-clean [REVIEW] → Atlas)
 *
 *   2. archivistAuto  — detect reusable patterns in agent output and
 *      automatically trigger Archivist to write a [MEMORY] entry. Heuristic-
 *      based; false positives are accepted as the cost of automatic
 *      knowledge capture.
 *
 *   3. echoFallback   — invoked when validateOutputAgainstSchema fails.
 *      Echo is the always-available catch-all in the failure chain
 *      (per FailureChain pattern from agent-fallback patterns research).
 */

import type { HandoffDirectiveV2 } from "./handoff.js";
import type { OutputSchema } from "./handoff.js";
import { nanoid } from "nanoid";

/**
 * Lowercase author id of the producing agent (atlas / forge / lens /
 * scout / analyst / writer / archivist / vis / echo / trainer / user).
 */
export type AgentId = string;

/**
 * Tag types recognized as first-class outputs. We use the same set as
 * extractAllTags() in handoff.ts.
 */
export type TagKind =
  | "RESULT" | "REVIEW" | "DECISION" | "QUESTION" | "BLOCKER" | "TODO" | "STATUS"
  | "RESEARCH" | "ANALYSIS" | "DOCUMENT" | "VISUAL" | "MEMORY";

/**
 * Severity levels recognized inside [REVIEW] blocks. Used by
 * detectReviewSeverity() to decide whether the review needs rework.
 */
export type ReviewSeverity = "critical" | "major" | "minor" | "clean";

export type ImplicitTarget = {
  agentId: AgentId;
  requiredOutputSchema: OutputSchema;
  reason: string;
};

/**
 * A rule fires when `match()` returns true. The trigger loop dispatches
 * the resulting `targets` in parallel (Promise.allSettled).
 */
export type ImplicitRule = {
  /** Short stable name for logs and debugging. */
  name: string;
  /** Predicate: should this rule fire given the producing agent, tags, and content? */
  match: (ctx: { from: AgentId; tags: TagKind[]; content: string }) => boolean;
  /** Targets to dispatch when the rule fires. */
  targets: (ctx: { from: AgentId; content: string; tags: TagKind[]; parentTraceId?: string }) => ImplicitTarget[];
};

/**
 * Inspect a [REVIEW] block and return the worst severity found, or "clean"
 * if the review explicitly states "all clean / no fix" or has no findings.
 */
export function detectReviewSeverity(content: string): ReviewSeverity {
  if (/\[REVIEW\]/i.test(content) === false) return "clean";

  // Worst-first ranking.
  if (/\bcritical\b/i.test(content)) return "critical";
  if (/\bmajor\b/i.test(content)) return "major";
  if (/\bminor\b/i.test(content)) return "minor";

  // Review exists but lists no severities — treat as "minor" (informational).
  return "minor";
}

/**
 * Heuristic for Archivist auto-derive. Triggers when:
 *   1. Output explicitly says "通用经验 / 可复用 / 通用 pattern / reusable /
 *      should remember / 建议归档" — these phrases are documented in
 *      SHARED_RULES as opt-in signals.
 *   2. Output is from Lens and contains "[REVIEW]" with `建议归档` tag —
 *      Lens has a dedicated review-completion signal for this.
 *   3. Output is from Forge and contains "// reusable:" or `# reusable:`
 *      comments — code-level signal that the author marked the change as
 *      a reusable pattern.
 */
const ARCHIVIST_TRIGGER_PHRASES = [
  /\b通用经验\b/,
  /\b可复用\b/,
  /\b通用 pattern\b/i,
  /\b通用pattern\b/i,
  /\breusable\b/i,
  /\bshould remember\b/i,
  /\bremember this\b/i,
  /\b建议归档\b/,
  /^\s*\/\/\s*reusable:/im,    // code comment form
  /^\s*#\s*reusable:/im,
];

export function shouldAutoArchive(content: string, fromAgent: AgentId): boolean {
  // Lens says "建议归档" — explicit archival signal.
  if (fromAgent === "lens" && /建议归档/.test(content)) return true;

  // Generic phrases — apply to any agent.
  for (const re of ARCHIVIST_TRIGGER_PHRASES) {
    if (re.test(content)) return true;
  }
  return false;
}

// ---------- rule registry ----------

const IMPLICIT_RULES: ImplicitRule[] = [
  // -- Forge output --
  {
    name: "forge_result_default_review",
    match: ({ from, tags }) => from === "forge" && tags.includes("RESULT"),
    targets: ({ parentTraceId }) => [{
      agentId: "lens",
      requiredOutputSchema: "review_block",
      reason: "Forge 完成实现 → 默认派 Lens review",
    }],
  },
  {
    name: "forge_result_auto_archive",
    match: ({ from, tags, content }) =>
      from === "forge" && tags.includes("RESULT") && shouldAutoArchive(content, from),
    targets: ({ parentTraceId }) => [{
      agentId: "archivist",
      requiredOutputSchema: "memory_write",
      reason: "Forge 输出标记为可复用 pattern → 自动派 Archivist 归档",
    }],
  },

  // -- Lens output --
  {
    name: "lens_review_rework",
    match: ({ from, tags, content }) =>
      from === "lens"
      && tags.includes("REVIEW")
      && ["critical", "major"].includes(detectReviewSeverity(content)),
    targets: ({ content }) => [{
      agentId: "forge",
      requiredOutputSchema: "result_block",
      reason: `Lens 标 ${detectReviewSeverity(content)} → 派 Forge 返工`,
    }],
  },
  {
    name: "lens_review_conclude",
    match: ({ from, tags, content }) =>
      from === "lens"
      && tags.includes("REVIEW")
      && tags.includes("STATUS")
      && !["critical", "major"].includes(detectReviewSeverity(content)),
    targets: () => [{
      agentId: "atlas",
      requiredOutputSchema: "decision_block",
      reason: "Lens review 全 minor / clean → 派 Atlas 收尾",
    }],
  },
  {
    name: "lens_review_auto_archive",
    match: ({ from, tags, content }) =>
      from === "lens"
      && tags.includes("REVIEW")
      && shouldAutoArchive(content, from),
    targets: () => [{
      agentId: "archivist",
      requiredOutputSchema: "memory_write",
      reason: "Lens review 建议归档 → 派 Archivist",
    }],
  },

  // -- Scout output --
  {
    name: "scout_research_to_analyst",
    match: ({ from, tags, content }) =>
      from === "scout" && tags.includes("RESEARCH") && hasMultipleFindings(content),
    targets: () => [{
      agentId: "analyst",
      requiredOutputSchema: "analysis",
      reason: "Scout 多条研究结果 → 派 Analyst 做带置信度的综合分析",
    }],
  },
  {
    name: "scout_research_simple_conclude",
    match: ({ from, tags, content }) =>
      from === "scout"
      && tags.includes("RESEARCH")
      && !hasMultipleFindings(content),
    targets: () => [{
      agentId: "atlas",
      requiredOutputSchema: "decision_block",
      reason: "Scout 简单研究 → 直接派 Atlas 收尾",
    }],
  },

  // -- Analyst output --
  {
    name: "analysis_to_writer",
    match: ({ from, tags, content }) =>
      from === "analyst" && tags.includes("ANALYSIS") && needsDocumentation(content),
    targets: () => [{
      agentId: "writer",
      requiredOutputSchema: "document",
      reason: "Analyst 输出需要文档化 → 派 Writer",
    }],
  },
  {
    name: "analysis_conclude",
    match: ({ from, tags }) =>
      from === "analyst" && tags.includes("ANALYSIS"),
    targets: () => [{
      agentId: "atlas",
      requiredOutputSchema: "decision_block",
      reason: "Analyst 分析完成 → 派 Atlas 收尾",
    }],
  },

  // -- Writer output --
  {
    name: "writer_to_lens",
    match: ({ from, tags }) => from === "writer" && tags.includes("DOCUMENT"),
    targets: () => [{
      agentId: "lens",
      requiredOutputSchema: "review_block",
      reason: "Writer 出文档 → 派 Lens review",
    }],
  },

  // -- Vis output --
  {
    name: "vis_error_to_analyst",
    match: ({ from, tags, content }) =>
      from === "vis" && tags.includes("VISUAL") && /error|错误|null|N\/A/i.test(content),
    targets: () => [{
      agentId: "analyst",
      requiredOutputSchema: "analysis",
      reason: "Vis 检测到错误 → 派 Analyst 分析根因",
    }],
  },
  {
    name: "vis_design_to_writer",
    match: ({ from, tags, content }) =>
      from === "vis" && tags.includes("VISUAL") && /mockup|design|设计/i.test(content),
    targets: () => [{
      agentId: "writer",
      requiredOutputSchema: "document",
      reason: "Vis 设计稿 → 派 Writer 出规范文档",
    }],
  },
  {
    name: "vis_conclude",
    match: ({ from, tags }) => from === "vis" && tags.includes("VISUAL"),
    targets: () => [{
      agentId: "atlas",
      requiredOutputSchema: "decision_block",
      reason: "Vis 输出 → 派 Atlas 收尾",
    }],
  },

  // -- Archivist output --
  {
    name: "archivist_conclude",
    match: ({ from, tags }) => from === "archivist" && tags.includes("MEMORY"),
    targets: () => [{
      agentId: "atlas",
      requiredOutputSchema: "decision_block",
      reason: "Archivist 已写入 memory → 派 Atlas 收尾",
    }],
  },
];

// ---------- helpers ----------

/**
 * "Multiple findings" heuristic: a Scout [RESEARCH] output that lists
 * 3+ numbered facts or contains "## 关键事实" implies enough material
 * for downstream analysis. Single-fact lookups don't.
 */
function hasMultipleFindings(content: string): boolean {
  // Conservative: treat as "multiple findings" when the content is long,
  // has a "## 关键事实" section, or lists 2+ numbered items. Single-fact
  // lookups stay short and are routed straight back to Atlas.
  const numbered = content.match(/\n\d+[.)]\s/g)?.length ?? 0;
  return content.length > 200 || /## 关键事实/.test(content) || numbered >= 2;
}

/**
 * "Needs documentation" heuristic: Analyst output that recommends
 * writing a report / doc / runbook / handoff doc.
 */
function needsDocumentation(content: string): boolean {
  return /建议.*报告|建议.*文档|建议写|runbook|handoff doc|write[- ]?up/i.test(content);
}

/**
 * Evaluate all implicit rules for a given agent output. Returns the
 * deduped target list (multiple rules can produce the same target).
 */
export function evaluateImplicitRules(ctx: {
  from: AgentId;
  tags: TagKind[];
  content: string;
}): ImplicitTarget[] {
  const seen = new Set<string>();
  const out: ImplicitTarget[] = [];
  for (const rule of IMPLICIT_RULES) {
    try {
      if (!rule.match(ctx)) continue;
    } catch (err) {
      console.warn(`[implicit] rule "${rule.name}" match() threw:`, err);
      continue;
    }
    const targets = rule.targets(ctx);
    for (const t of targets) {
      const key = `${t.agentId}:${t.requiredOutputSchema}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

// ---------- echo fallback builder ----------

/**
 * Build the handoff v2 directive to Echo when an agent failed to produce
 * a valid output for the required schema. Echo is the always-available
 * catch-all — it acknowledges the original intent and either produces
 * a degraded response or escalates to the user via [BLOCKER].
 *
 * Used by the trigger loop when validateOutputAgainstSchema() returns
 * false on a handoff with requiredOutputSchema set.
 */
export function buildEchoFallback(opts: {
  from: AgentId;
  parentTraceId: string;
  parentContent: string;
  expectedSchema: OutputSchema;
  originalTaskSummary?: string;
}): HandoffDirectiveV2 {
  const truncated = opts.parentContent.length > 1500
    ? opts.parentContent.slice(0, 1500) + "..."
    : opts.parentContent;
  const fallbackSummary =
    `兜底接管: 上游 agent "${opts.from}" 在 handoff chain ` +
    `(traceId=${opts.parentTraceId}) 中未能产出 requiredOutputSchema="${opts.expectedSchema}" 的有效输出。` +
    (opts.originalTaskSummary ? `\n\n原任务: ${opts.originalTaskSummary}` : "") +
    `\n\n请接管这个任务，按"${opts.expectedSchema}"要求产出回复。若信息不足无法处理，输出 [BLOCKER] 让用户介入。`;

  return {
    schemaVersion: "2.0",
    traceId: nanoid(),
    rawTraceId: opts.parentTraceId,
    to: [{ id: "echo", name: "Echo", rawName: "echo" }],
    taskSummary: fallbackSummary,
    requiredOutputSchema: opts.expectedSchema,
    failurePolicy: {
      onInvalidOutput: "escalate",   // if Echo also fails, escalate to user
      onTimeout: "escalate",
      maxRetries: 0,
    },
    provenance: {
      parentAgent: opts.from,
      contextExcerpt: truncated,
    },
  };
}

/**
 * All registered rules — exposed for debugging, the REST API, and tests.
 */
export const IMPLICIT_RULE_NAMES = IMPLICIT_RULES.map((r) => r.name);