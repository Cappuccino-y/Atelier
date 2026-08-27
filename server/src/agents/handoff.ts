/**
 * Handoff v2 typed payload schema and parser.
 *
 * Industry consensus (OpenAI Agents SDK, Google A2A protocol, Anthropic
 * multi-agent research, Microsoft Agent Framework) is that inter-agent
 * payloads MUST be structured contracts, not free-text prose. The previous
 * v1 format was `{"to": [...], "task": "..."}` — too thin, prone to silent
 * drift. v2 adds:
 *
 *   - schemaVersion   — for backward-incompatible migrations
 *   - traceId         — single id propagated through the entire task tree
 *   - taskSummary     — replaces v1 `task` with explicit field
 *   - provenance      — parent agent + parent message id + STRUCTURED context
 *                       (v2.1: replaces the v2.0 `contextExcerpt` string with
 *                       a typed object — taskSummary + outputHighlights +
 *                       attachedFacts + skippedNoise + parentChain)
 *   - requiredOutputSchema — what tag/output downstream agent must produce
 *   - constraints     — deadline / token budget
 *   - evidenceStandard — strict / balanced / loose (mirrors Anthropic's
 *                       extended-thinking budget levels)
 *   - failurePolicy   — fallback_echo / retry / escalate on invalid output
 *
 * Only v2 blocks are accepted on the wire (v1 was retired — it carried no
 * traceId, breaking retry/dedupe/tracing, and went unused in production).
 * Parsing returns a normalized v2 object (HandoffDirectiveV2) with sensible
 * defaults filled in, so callers don't need to branch on schema version.
 *
 * Backward compatibility for v2.0 agents: the legacy `contextExcerpt` string
 * field is still accepted and rendered (as `[context excerpt]: ...`). New
 * agents should emit the structured `context` block instead. Both can
 * coexist — structured wins when present.
 */

import { z } from "zod";
import { nanoid } from "nanoid";

/**
 * What output schema the requesting agent expects from the receiving agent.
 * Used by the server to validate the receiver's reply and trigger
 * failurePolicy.onInvalidOutput if the produced tag doesn't match.
 */
export const OutputSchemaEnum = z.enum([
  "result_block",     // [RESULT]
  "review_block",     // [REVIEW] with severity
  "decision_block",   // [DECISION]
  "research_brief",   // [RESEARCH] — Scout
  "analysis",         // [ANALYSIS] — Analyst
  "document",         // [DOCUMENT] — Writer
  "visual_brief",     // [VISUAL] — Lens
  "memory_write",     // [MEMORY] — Archivist (only)
  "answer_text",      // plain prose reply
]);

export type OutputSchema = z.infer<typeof OutputSchemaEnum>;

/**
 * v2.1 structured handoff context — replaces the v2.0 `contextExcerpt` string
 * with a typed object so downstream agents receive explicit coordination
 * metadata instead of an opaque text blob. Each field has a clear role:
 *
 *   - taskSummary     — upstream agent's task in one line (echo of the
 *                       parent handoff's taskSummary, for self-contained
 *                       context).
 *   - outputHighlights — 1-3 bullet conclusions from upstream, the parts
 *                       downstream MUST build on. Lets the receiver skip
 *                       the upstream's intermediate reasoning while keeping
 *                       the decisions.
 *   - attachedFacts   — cross-step facts downstream MUST honor (deadlines,
 *                       workspace paths, conventions). Survives truncation.
 *   - skippedNoise    — explicit log of what was omitted from upstream's
 *                       output before forwarding. Tells downstream not to
 *                       re-explore that territory.
 *   - parentChain     — traceId ancestors (root → immediate parent). Cheap
 *                       way for downstream to see how deep the chain is.
 */
export const HandoffContextSchema = z.object({
  taskSummary: z.preprocess(
    (v) => (typeof v === "string" ? v.slice(0, 500) : v),
    z.string().min(1).max(500).optional(),
  ),
  outputHighlights: z.preprocess(
    (v) => (Array.isArray(v) ? v.slice(0, 5).map((s) => String(s).slice(0, 300)) : v),
    z.array(z.string().min(1)).max(5).optional(),
  ),
  attachedFacts: z.preprocess(
    (v) => (Array.isArray(v) ? v.slice(0, 8).map((s) => String(s).slice(0, 300)) : v),
    z.array(z.string().min(1)).max(8).optional(),
  ),
  skippedNoise: z.preprocess(
    (v) => (Array.isArray(v) ? v.slice(0, 8).map((s) => String(s).slice(0, 200)) : v),
    z.array(z.string().min(1)).max(8).optional(),
  ),
  parentChain: z.preprocess(
    (v) => (Array.isArray(v) ? v.slice(0, 20).map((s) => String(s)) : v),
    z.array(z.string()).max(20).optional(),
  ),
});
export type HandoffContext = z.infer<typeof HandoffContextSchema>;

/**
 * What tag the agent should output for each OutputSchema. Used to validate
 * the receiver's reply.
 */
export const OUTPUT_SCHEMA_TO_TAG: Record<OutputSchema, string> = {
  result_block:   "RESULT",
  review_block:   "REVIEW",
  decision_block: "DECISION",
  research_brief: "RESEARCH",
  analysis:       "ANALYSIS",
  document:       "DOCUMENT",
  visual_brief:   "VISUAL",
  memory_write:   "MEMORY",
  answer_text:    "",
};

export const EvidenceStandardEnum = z.enum(["strict", "balanced", "loose"]);

export const FailureActionEnum = z.enum(["fallback_echo", "retry", "escalate"]);

/**
 * Full v2.1 handoff schema. v2.1 adds optional `intent` (semantic intent
 * of the handoff — e.g. "verify_fix" / "request_analysis") and
 * `attachmentRefs` (references to images, files, prior message ids that
 * downstream agents should look at). The server is permissive on `to`
 * (accepts both v1 string-array form and richer object form) but strict
 * on the wrapper fields once schemaVersion is present.
 *
 * v2.0 → v2.1 migration: just include any new optional fields you need.
 * Older v2.0 blocks still parse because every v2.1 field is optional.
 */
export const HandoffPayloadV2_1Schema = z.object({
  schemaVersion: z.union([z.literal("2.0"), z.literal("2.1")]),
  // traceId is OPTIONAL on the wire — the server generates one when absent
  // (SHARED_RULES: "traceId 由 server 自动生成"). Required here would
  // reject every well-behaved handoff that follows the prompt examples,
  // which omit it.
  traceId: z.string().min(1).optional(),
  // `to` semantic contract:
  //   - 1 target   → single-hop handoff (sequential — the receiver decides
  //                  the next hop by emitting its own handoff).
  //   - 2+ targets → PARALLEL fan-out. There is NO ordering between them;
  //                  the server dispatches all simultaneously and each
  //                  receiver concludes independently. Sequential intent
  //                  must NEVER be encoded as a multi-target `to` array —
  //                  express it as single-target hops (A → B → C).
  // Per-target tasks: when parallel targets need DIFFERENT tasks (the
  // common case — e.g. Forge explores local files while Scout researches
  // online), each object entry can carry its own `taskSummary`, which
  // overrides the top-level taskSummary for that receiver. This is the
  // LangGraph Send-style contract: one routing decision, N independent
  // payloads. Agents must NOT emit multiple separate handoff JSON objects
  // for parallelism — one handoff with a multi-target `to` array is the
  // only supported fan-out mechanism.
  // Accepted forms (LLMs drift between them):
  //   - string:              "atlas"
  //   - object:              {"id":"atlas"} / {"name":"Atlas"} /
  //                          {"id":"atlas","name":"Atlas","rawName":"atlas"} /
  //                          {"rawName":"atlas"} /
  //                          {"name":"forge","taskSummary":"探索本地材料"} /
  //                          {"name":"scout","taskSummary":"在线调研"}
  to: z.array(
    z.union([
      z.string().min(1),
      z.object({
        id: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        rawName: z.string().min(1).optional(),
        taskSummary: z.preprocess(
          (v) => (typeof v === "string" ? v.slice(0, 2000) : v),
          z.string().min(1).max(2000).optional(),
        ),
        // Per-target output schema — overrides the shared requiredOutputSchema
        // for THIS receiver. In a parallel fan-out where each agent produces
        // a different kind of artifact (Forge: result_block, Lens:
        // review_block, Scout: research_brief), the shared top-level schema
        // would wrongly force everyone to the same tag. This lets each
        // target declare its own.
        requiredOutputSchema: OutputSchemaEnum.optional(),
      }).refine((o) => o.id || o.name || o.rawName, { message: "to entry needs id, name or rawName" }),
    ])
  ).min(1),
  // taskSummary: clamp to 2000 chars instead of rejecting — a long task
  // description is far more common from LLMs than a short one, and dropping
  // the whole handoff over length is worse than truncating the summary.
  taskSummary: z.preprocess(
    (v) => (typeof v === "string" ? v.slice(0, 2000) : v),
    z.string().min(1).max(2000),
  ),
  provenance: z.object({
    parentAgent: z.string().optional(),
    parentMessageId: z.string().optional(),
    /** v2.1 structured context (preferred over contextExcerpt). */
    context: HandoffContextSchema.optional(),
    /** v2.0 legacy string excerpt. Still parsed + rendered for back-compat
     *  with agents written before structured context existed. Structured
     *  `context` wins when both are present. */
    contextExcerpt: z.string().max(2000).optional(),
  }).optional(),
  requiredOutputSchema: OutputSchemaEnum.optional(),
  constraints: z.object({
    deadlineMs: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
  }).optional(),
  evidenceStandard: EvidenceStandardEnum.optional(),
  failurePolicy: z.object({
    // Industry practice: validation failure is usually a transient format
    // mistake — retry with feedback FIRST (LangChain ToolStrategy, Geodocs
    // spec: "retry once with violation appended"). escalate is the LAST
    // resort, not the default.
    onInvalidOutput: FailureActionEnum.default("retry"),
    onTimeout: FailureActionEnum.default("fallback_echo"),
    // Clamp instead of reject: models occasionally write maxRetries: 5.
    maxRetries: z.preprocess((v) => Math.min(Math.max(Number(v) || 0, 0), 3), z.number().int().min(0).max(3)).default(1),
  }).optional(),
  /** v2.1 only — semantic intent of this handoff (free-text, clamped to 200 chars). */
  intent: z.preprocess(
    (v) => (typeof v === "string" ? v.slice(0, 200) : v),
    z.string().min(1).max(200).optional(),
  ),
  /** v2.1 only — references to images / files / message ids downstream
   *  agents should consult. Clamped to 20 entries instead of rejecting. */
  attachmentRefs: z.preprocess(
    (v) => (Array.isArray(v) ? v.slice(0, 20).map((s) => String(s).slice(0, 300)) : v),
    z.array(z.string().min(1)).max(20).optional(),
  ),
});

/** @deprecated use HandoffPayloadV2_1Schema for new code. Kept as alias. */
export const HandoffPayloadV2Schema = HandoffPayloadV2_1Schema;

export type HandoffPayloadV2 = z.infer<typeof HandoffPayloadV2_1Schema>;

/**
 * Top-level handoff directive after parsing + resolving agent ids. This
 * is what triggers.ts / runtime.ts consume. It's always v2-shape
 * regardless of what schema the producing agent wrote.
 */
export type HandoffDirectiveV2 = {
  schemaVersion: "2.0" | "2.1";
  traceId: string;
  rawTraceId: string;          // traceId actually emitted by the agent (may be a UUID or anything)
  to: Array<{
    id: string;
    name: string;
    rawName: string;
    /** Per-target task. Overrides the shared taskSummary for this receiver
     *  (parallel fan-out with different tasks per agent). */
    taskSummary?: string;
    /** Per-target output schema. Overrides the shared requiredOutputSchema
     *  for this receiver (parallel fan-out with different artifact types). */
    requiredOutputSchema?: OutputSchema;
  }>;
  taskSummary: string;
  provenance?: HandoffPayloadV2["provenance"];
  requiredOutputSchema?: OutputSchema;
  constraints?: HandoffPayloadV2["constraints"];
  evidenceStandard?: "strict" | "balanced" | "loose";
  /** v2.1 only — semantic intent of this handoff. */
  intent?: string;
  /** v2.1 only — references to images / files / message ids downstream
   *  agents should consult. */
  attachmentRefs?: string[];
  failurePolicy: {
    onInvalidOutput: "fallback_echo" | "retry" | "escalate";
    onTimeout: "fallback_echo" | "retry" | "escalate";
    maxRetries: number;
  };
};

/**
 * Locator for an agent by name or id. Returns the resolved agent row or
 * null. Imported lazily to avoid a circular dep with triggers.ts.
 */
export type AgentLocator = (raw: string) => { id: string; name: string } | null;

export const HANDOFF_RE = /```handoff\s*\n([\s\S]*?)```/;

/**
 * A single brace-balanced `{ ... }` object found in the reply text,
 * along with its byte offsets so it can be stripped from the display.
 */
type JsonMatch = { text: string; start: number; end: number };

/**
 * Scan the reply for every brace-balanced `{ ... }` object. This replaces
 * the old ```handoff``` fence matching: we no longer require the model to
 * wrap the handoff in a code fence. Instead we find every top-level JSON
 * object (skipping braces inside string literals) and let the schema
 * validation in parseHandoff decide which one is actually a handoff.
 *
 * This kills the nested-fence failure mode entirely — there is no fence to
 * truncate, and braces inside a `taskSummary` string are correctly skipped.
 *
 * NOTE: naive whole-text scanning has a real failure mode — prose that
 * contains ASCII double quotes (Chinese text like "假两栏" written with
 * straight quotes) corrupts the in-string state of the scan, so a stray
 * `{` from a CSS/JS code block can swallow the rest of the reply and the
 * real handoff JSON is never seen. Best practice (see athenaeum,
 * json-from-llm, ai-json-safe-parse) is to try the most promising regions
 * FIRST: markdown-fenced JSON blocks, then objects anchored on a known
 * required key (`"schemaVersion"`), and only fall back to a whole-text
 * scan. locateHandoffJson does exactly that.
 */

/**
 * Scan from a `{` at `start` for the balanced closing `}`. String-aware
 * (skips braces inside string literals, tolerates bare ASCII quotes inside
 * strings as a non-terminator unless followed by a JSON structural char).
 * Returns the matched span, or null if unbalanced/unterminated.
 */
function scanBalancedObjectAt(content: string, start: number): JsonMatch | null {
  let depth = 0;
  let inString = false;
  for (let j = start; j < content.length; j++) {
    const ch = content[j];
    if (inString) {
      if (ch === "\\") { j++; continue; }
      if (ch === '"') {
        // Bare-quote tolerance: a `"` is a real string terminator only if
        // what follows (skipping whitespace) is a JSON structural char
        // (`, ] } :`) or end-of-input. `"关停"` / `"假两栏"` written with
        // straight quotes stay inside the string. Mirrors repairJson.
        const after = content.slice(j + 1);
        const fns = after.match(/\S/);
        const firstNonWs = fns ? after[fns.index!] : undefined;
        if (firstNonWs === undefined || /[,\]\}:]/.test(firstNonWs)) inString = false;
      }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { text: content.slice(start, j + 1), start, end: j + 1 };
    }
  }
  return null;
}

/**
 * Extract candidates from markdown-fenced JSON blocks (```json / ```jsonc /
 * bare ```), in document order. Fenced content is the strongest signal that
 * the model meant "this is JSON" (see athenaeum's fence-first extraction).
 */
function fencedCandidates(content: string): JsonMatch[] {
  const out: JsonMatch[] = [];
  const fenceRe = /^[ ]{0,3}```(?:jsonc?|JSON)?[^\n]*\n([\s\S]*?)^[ ]{0,3}```/gm;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(content))) {
    const inner = m[1];
    // Trim the inner block; offsets stay approximate — the candidate text
    // is what matters, stripHandoffBlock re-scans the raw content anyway.
    const trimmed = inner.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const start = m.index + m[0].indexOf(trimmed);
      out.push({ text: trimmed, start, end: start + trimmed.length });
    }
  }
  return out;
}

/**
 * Anchor-based candidates: find every `"schemaVersion"` key, verify the
 * non-whitespace char before it is `{` or `,` (a real JSON object key),
 * then balance-scan from that `{`. This skips prose noise entirely —
 * body text mentioning `"schemaVersion"` without an object position is
 * rejected, and a stray `{` from a CSS block is never even considered.
 */
function anchoredCandidates(content: string): JsonMatch[] {
  const out: JsonMatch[] = [];
  let from = 0;
  for (;;) {
    const idx = content.indexOf('"schemaVersion"', from);
    if (idx === -1) break;
    let prev = idx - 1;
    while (prev >= 0 && /\s/.test(content[prev])) prev--;
    if (prev >= 0 && (content[prev] === "{" || content[prev] === ",")) {
      const match = scanBalancedObjectAt(content, prev);
      if (match) out.push(match);
    }
    from = idx + 1;
  }
  return out;
}

/**
 * Whole-text fallback: scan every `{` in document order and balance-scan
 * from it. This is the last resort — it is the least precise (prose braces
 * from CSS/JS samples can interfere) but guarantees a well-formed handoff
 * is found even when it is not fenced and its `schemaVersion` anchor got
 * mangled. Uses scanBalancedObjectAt for string-aware balancing.
 */
function findBalancedJsonObjects(content: string): JsonMatch[] {
  const out: JsonMatch[] = [];
  let i = 0;
  while (i < content.length) {
    const start = content.indexOf("{", i);
    if (start === -1) break;
    const match = scanBalancedObjectAt(content, start);
    if (!match) {
      // Unclosed `{` — a markdown code sample or prose with an unbalanced
      // brace. Skip PAST this brace instead of aborting the whole scan, so a
      // later well-formed handoff JSON is still found.
      i = start + 1;
      continue;
    }
    out.push(match);
    i = match.end;
  }
  return out;
}

/**
 * Best-effort repair for a JSON string that fails strict parse. Handles
 * the most common LLM drift patterns:
 *   1. Trailing commas before } or ]
 *   2. Illegal escape sequences in strings — e.g. a Windows path like
 *      `D:\浏览器下载文件\x.yml` where `\浏` is not a valid JSON escape.
 *      In JSON string context, a backslash followed by anything outside
 *      `"\/bfnrtu` is invalid; we escape the backslash itself (`\\浏`),
 *      which preserves the literal path characters.
 *   3. Bare ASCII double quotes INSIDE string values — e.g. a model writing
 *      `"关停"` with ASCII quotes instead of Chinese quotes `"关停"` in a
 *      taskSummary. The quote prematurely terminates the string, so the
 *      JSON.parse error is "Expected ',' or '}' after property value".
 *      Heuristic: inside a string, a `"` whose NEXT character is not a
 *      JSON structural char (`, ] } : `, whitespace, or end-of-input) is a
 *      bare quote and gets escaped as `\"`.
 * Returns the repaired string, or null if no repair applies.
 */
function repairJson(raw: string): string | null {
  const trimmed = raw.trim();
  // 1. Remove trailing commas before } or ] — the #1 malformed-JSON drift.
  const noTrailingCommas = trimmed.replace(/,\s*([}\]])/g, "$1");
  if (noTrailingCommas !== trimmed) {
    try { JSON.parse(noTrailingCommas); return noTrailingCommas; } catch { /* fall through */ }
  }

  // Walk every string literal once, fixing BOTH illegal escapes (rule 2)
  // and bare ASCII quotes (rule 3). Structural chars are copied through.
  let out = "";
  let i = 0;
  let inString = false;
  let changed = false;
  while (i < noTrailingCommas.length) {
    const ch = noTrailingCommas[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      i++;
      continue;
    }
    if (ch === "\\") {
      const next = noTrailingCommas[i + 1];
      if (next === undefined) { out += ch; i++; continue; }
      if (/["\\/bfnrtu]/.test(next)) {
        // valid escape — keep as-is
        out += ch + next;
        i += 2;
      } else {
        // invalid escape — escape the backslash itself
        out += "\\\\" + next;
        i += 2;
        changed = true;
      }
      continue;
    }
    if (ch === '"') {
      // Decide: string terminator or bare ASCII quote?
      // A quote is a real terminator only if what follows (skipping
      // whitespace) is a JSON structural char (`, ] } : `) or end-of-input.
      // `"性能达标" 4)` — quote, space, digit — is a bare-quote pair.
      const after = noTrailingCommas.slice(i + 1);
      const firstNonWsMatch = after.match(/\S/);
      const firstNonWs = firstNonWsMatch ? after[firstNonWsMatch.index!] : undefined;
      const isTerminator = firstNonWs === undefined || /[,\]\}:]/.test(firstNonWs);
      if (isTerminator) {
        out += ch;
        inString = false;
      } else {
        // Bare quote mid-string (e.g. "关停" with ASCII quotes) — escape it.
        out += "\\\"";
        changed = true;
      }
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  if (changed) {
    try { JSON.parse(out); return out; } catch { /* keep original */ }
  }
  return null;
}

/**
 * Find the raw JSON text of the handoff object in the reply, or null.
 * Scans candidates in priority order and returns the first one that parses
 * to a recognized handoff shape (v2.1/v2.0). Used by both parseHandoff
 * and stripHandoffBlock so the two stay consistent.
 *
 * Candidate priority (best practice for extracting JSON from LLM prose):
 *   1. Markdown-fenced JSON blocks (```json ... ```) — the model's most
 *      explicit "this is JSON" signal.
 *   2. Objects anchored on the `"schemaVersion"` key — our handoff schema
 *      requires it, and in real JSON its preceding non-whitespace char is
 *      always `{` or `,`. This skips prose noise (CSS/JS samples, Chinese
 *      text with straight ASCII quotes) that corrupts whole-text scans.
 *   3. Whole-text brace scan — last resort for mangled output.
 *
 * `text` in the returned match may be REPAIRED (trailing commas / illegal
 * escapes / bare quotes fixed) — callers must parse `match.text`, not
 * re-scan the raw content, or the repair is silently undone.
 */
function locateHandoffJson(content: string): JsonMatch | null {
  // Deduplicate by start offset (a fenced object is often also found by
  // the anchor scan; the whole-text scan would find it again).
  const seen = new Set<number>();
  const candidates = [
    ...fencedCandidates(content),
    ...anchoredCandidates(content),
    ...findBalancedJsonObjects(content),
  ];
  for (const match of candidates) {
    if (seen.has(match.start)) continue;
    seen.add(match.start);
    let raw: unknown;
    let reparsed = match.text;
    try {
      raw = JSON.parse(match.text);
    } catch {
      const repaired = repairJson(match.text);
      if (!repaired) continue;
      try { raw = JSON.parse(repaired); } catch { continue; }
      reparsed = repaired;
    }
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    if (obj.schemaVersion === "2.0" || obj.schemaVersion === "2.1") {
      if (HandoffPayloadV2_1Schema.safeParse(obj).success) return { ...match, text: reparsed };
    }
    // Anything else — no schemaVersion (legacy v1, unsupported), or an
    // unknown schemaVersion string (future v3) — is rejected, never
    // treated as a handoff.
  }
  return null;
}

/**
 * Parse an agent's reply for a handoff. Accepts v2, with or without the
 * legacy ```handoff``` code fence. Returns null if no handoff is found, or
 * a HandoffDirectiveV2 if one parses + resolves to at least one known
 * agent.
 *
 * The agent may emit the handoff as a bare JSON object anywhere in its
 * reply — no code fence required. If multiple JSON objects are present,
 * the first that matches the handoff schema is used. EXACTLY ONE handoff
 * per reply is the contract: parallel fan-out is expressed as a
 * multi-target `to` array (optionally with per-target taskSummary), never
 * as multiple JSON objects — the first object wins and the rest are
 * ignored, consistent with OpenAI Swarm ("only the last handoff is used")
 * and AutoGen's warning that concurrent handoffs cause unexpected
 * behavior.
 */
export function parseHandoff(content: string, locator: AgentLocator): HandoffDirectiveV2 | null {  const match = locateHandoffJson(content);
  if (!match) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(match.text);
  } catch {
    const repaired = repairJson(match.text);
    if (!repaired) return null;
    try {
      raw = JSON.parse(repaired);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;

  // Branch on schemaVersion marker. v2.0 and v2.1 share the same parser
  // — the only difference is optional `intent` / `attachmentRefs` fields.
  if (obj.schemaVersion === "2.0" || obj.schemaVersion === "2.1") {
    const parsed = HandoffPayloadV2_1Schema.safeParse(obj);
    if (!parsed.success) return null;
    return resolveV2(parsed.data, locator);
  }

  // Unknown schemaVersion (e.g. a future v3 block) — reject rather than
  // misparse. v1 is intentionally NOT supported anymore: it carries no
  // traceId (breaking retry/dedupe/tracing) and has been unused since v2
  // became the sole format (0/53 parsed handoffs were v1 in production).
  return null;
}

/**
 * Diagnose WHY parseHandoff returned null despite the reply looking like it
 * contains a handoff. Returns a human-readable reason, or null when the
 * reply simply has no handoff-shaped JSON at all. Used for logging/UI so a
 * silently-broken chain is debuggable instead of a mystery.
 */
export function diagnoseHandoffFailure(content: string, locator: AgentLocator): string | null {
  for (const match of findBalancedJsonObjects(content)) {
    let raw: unknown;
    try {
      raw = JSON.parse(match.text);
    } catch {
      const repaired = repairJson(match.text);
      if (!repaired) continue;
      try { raw = JSON.parse(repaired); } catch { continue; }
    }
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    if (obj.schemaVersion === "2.0" || obj.schemaVersion === "2.1") {
      const parsed = HandoffPayloadV2_1Schema.safeParse(obj);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).slice(0, 4).join("; ");
        return `handoff-like JSON found but schema rejected — ${issues || "unknown"}`;
      }
      const d = resolveV2(parsed.data, locator);
      if (!d) return "handoff schema OK but none of the targets resolved to a known agent";
      return null; // actually parses — no failure
    }
    if (typeof obj.schemaVersion === "string") {
      return `unknown schemaVersion "${obj.schemaVersion}"`;
    }
    // No schemaVersion at all — legacy v1 shape (retired) or unrelated JSON.
    if (Array.isArray(obj.to)) {
      return "handoff-like JSON without schemaVersion (v1 is retired — please use schemaVersion: \"2.0\")";
    }
  }
  return null;
}

function resolveV2(payload: HandoffPayloadV2, locator: AgentLocator): HandoffDirectiveV2 | null {
  const seen = new Set<string>();
  const resolved: Array<{ id: string; name: string; rawName: string; taskSummary?: string; requiredOutputSchema?: OutputSchema }> = [];
  for (const entry of payload.to) {
    // Accept both string ("atlas") and object ({id|name|rawName}) forms.
    // Object entries may carry a per-target taskSummary + requiredOutputSchema
    // (parallel fan-out with different tasks/artifacts per agent).
    const rawName = typeof entry === "string" ? entry : (entry.id ?? entry.name ?? entry.rawName ?? "");
    const agent = locator(rawName);
    if (agent && !seen.has(agent.id)) {
      resolved.push({
        id: agent.id,
        name: agent.name,
        rawName,
        taskSummary: typeof entry === "object" ? entry.taskSummary : undefined,
        requiredOutputSchema: typeof entry === "object" ? entry.requiredOutputSchema : undefined,
      });
      seen.add(agent.id);
    }
  }
  if (resolved.length === 0) return null;
  const fp = payload.failurePolicy ?? { onInvalidOutput: "retry" as const, onTimeout: "fallback_echo" as const, maxRetries: 1 };
  return {
    schemaVersion: payload.schemaVersion,
    traceId: payload.traceId ?? nanoid(),
    rawTraceId: payload.traceId ?? "",
    to: resolved,
    taskSummary: payload.taskSummary,
    provenance: payload.provenance,
    requiredOutputSchema: payload.requiredOutputSchema,
    constraints: payload.constraints,
    evidenceStandard: payload.evidenceStandard,
    intent: payload.intent,
    attachmentRefs: payload.attachmentRefs,
    failurePolicy: {
      onInvalidOutput: fp.onInvalidOutput ?? "fallback_echo",
      onTimeout: fp.onTimeout ?? "fallback_echo",
      maxRetries: fp.maxRetries ?? 1,
    },
  };
}

/**
 * Strip the handoff JSON object from the reply for display purposes.
 * Locates the same object parseHandoff would use, then removes it (plus a
 * wrapping ```handoff fence if present) so routing metadata never leaks
 * into the UI. Exactly ONE handoff object per reply is the contract —
 * parallel fan-out is expressed as a multi-target `to` array, never as
 * multiple JSON objects.
 */
export function stripHandoffBlock(content: string): string {
  const match = locateHandoffJson(content);
  if (!match) return content.replace(/\n{3,}/g, "\n\n").trim();

  // The handoff may be wrapped in a ```handoff fence — extend the removal
  // window to swallow an immediately-preceding fence opener and the first
  // closing ``` after the JSON.
  let start = match.start;
  const open = content.lastIndexOf("```handoff", match.start);
  if (open !== -1 && content.slice(open, match.start).trim() === "```handoff") {
    start = open;
  }
  let end = match.end;
  const closeFence = content.indexOf("```", match.end);
  if (closeFence !== -1 && content.slice(match.end, closeFence).trim() === "") {
    end = closeFence + 3;
  }

  const before = content.slice(0, start);
  const after = content.slice(end);
  return (before + after).replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Format the handoff task trailer that gets appended to the receiving
 * agent's prompt. v2.1 renders structured `provenance.context` (preferred);
 * falls back to v2.0 `provenance.contextExcerpt` for back-compat.
 */
export function formatHandoffTaskTrailer(directive: HandoffDirectiveV2): string {
  const parts: string[] = [];
  parts.push(`[handoff task — schemaVersion: ${directive.schemaVersion} — from: ${directive.provenance?.parentAgent ?? "unknown"} — traceId: ${directive.traceId}]`);
  parts.push(directive.taskSummary);
  if (directive.intent) {
    parts.push(`\n[intent]: ${directive.intent}`);
  }
  if (directive.attachmentRefs && directive.attachmentRefs.length > 0) {
    parts.push(`\n[attachment refs]: ${directive.attachmentRefs.join(", ")}`);
  }
  if (directive.requiredOutputSchema) {
    const expected = OUTPUT_SCHEMA_TO_TAG[directive.requiredOutputSchema];
    parts.push(`\n[required output schema: ${directive.requiredOutputSchema}${expected ? ` — produce a [${expected}] tag block` : ""}]`);
  }
  if (directive.evidenceStandard) {
    parts.push(`\n[evidence standard: ${directive.evidenceStandard}]`);
  }
  if (directive.constraints) {
    const c = directive.constraints;
    const bits: string[] = [];
    if (c.deadlineMs != null) bits.push(`deadline=${(c.deadlineMs / 1000).toFixed(0)}s`);
    if (c.maxTokens != null) bits.push(`maxTokens=${c.maxTokens}`);
    if (bits.length > 0) parts.push(`\n[constraints]: ${bits.join("; ")}`);
  }
  // v2.1 structured context (preferred)
  const ctx = directive.provenance?.context;
  if (ctx) {
    const blocks: string[] = [];
    if (ctx.taskSummary) blocks.push(`taskSummary: ${ctx.taskSummary}`);
    if (ctx.outputHighlights && ctx.outputHighlights.length > 0) {
      blocks.push(`outputHighlights:\n${ctx.outputHighlights.map((h) => `  - ${h}`).join("\n")}`);
    }
    if (ctx.attachedFacts && ctx.attachedFacts.length > 0) {
      blocks.push(`attachedFacts (must honor):\n${ctx.attachedFacts.map((f) => `  - ${f}`).join("\n")}`);
    }
    if (ctx.skippedNoise && ctx.skippedNoise.length > 0) {
      blocks.push(`skippedNoise (do not re-explore):\n${ctx.skippedNoise.map((n) => `  - ${n}`).join("\n")}`);
    }
    if (ctx.parentChain && ctx.parentChain.length > 0) {
      blocks.push(`parentChain: ${ctx.parentChain.join(" → ")}`);
    }
    if (blocks.length > 0) {
      parts.push(`\n[handoff context]:\n${blocks.join("\n")}`);
    }
  }
  // v2.0 legacy fallback
  if (!ctx && directive.provenance?.contextExcerpt) {
    parts.push(`\n[context excerpt]:\n${directive.provenance.contextExcerpt}`);
  }
  return parts.join("\n");
}

/**
 * Validate a receiver's reply against the required output schema. Used by
 * the orchestrator to decide whether failurePolicy.onInvalidOutput kicks
 * in. Returns true if the output matches (or if no schema was required).
 */
export function validateOutputAgainstSchema(content: string, required?: OutputSchema): boolean {
  return validateOutputAgainstSchemaDetailed(content, required).ok;
}

/**
 * Detailed variant — same rules as validateOutputAgainstSchema, but returns
 * a human-readable reason so a retry can feed the SPECIFIC failure back to
 * the model (industry practice: "previous response failed validation: X.
 * Fix it and respond again" — vague retries waste tokens and rarely
 * succeed). Callers that only need a boolean should use the cheap wrapper.
 */
export function validateOutputAgainstSchemaDetailed(content: string, required?: OutputSchema): { ok: boolean; reason: string | null } {
  if (!required) return { ok: true, reason: null };
  // decision_block is treated as answer_text — the orchestrator's "decision"
  // is expressed by either a ```handoff``` block (dispatch) or a prose
  // summary (reply), NOT by a mandatory [DECISION] tag. Requiring both the
  // tag and the handoff was a "specification ambiguity" failure (MAST
  // taxonomy) — agents produced one but not the other and the chain died.
  // Any non-empty reply satisfies the orchestrator's contract.
  if (required === "answer_text" || required === "decision_block")
    return content.trim().length > 0 ? { ok: true, reason: null } : { ok: false, reason: "reply is empty" };
  const expectedTag = OUTPUT_SCHEMA_TO_TAG[required];
  if (!expectedTag) return { ok: true, reason: null };
  // Allow either [TAG] or [TAG:DEPRECATE] — a deprecation block is still
  // a valid answer to a memory_write request, etc.
  const strictRe = new RegExp(`\\[${expectedTag}(:DEPRECATE)?(:\\w+)?\\]`, "i");
  if (strictRe.test(content)) return { ok: true, reason: null };
  // Lenient fallback: LLMs occasionally write the schema name or a
  // prose-ish label instead of the bracketed tag (e.g. `research_brief:` or
  // `RESEARCH` on its own line). Treat those as satisfied — the tag is a
  // display marker (SHARED_RULES: "声明 != 产出"), and failing a whole run
  // over bracket style is worse than a slightly loose check.
  const lenientRe = new RegExp(`(?:\\[)?(?:${expectedTag}|${required})\\b(?::\\w+)?(?:\\])?`, "i");
  if (lenientRe.test(content)) return { ok: true, reason: null };
  return { ok: false, reason: `reply does not contain the required [${expectedTag}] block (requiredOutputSchema="${required}")` };
}

/**
 * Extract all tags from a reply. Extended in v2 to recognize the new
 * agent-specific tags: [RESEARCH], [ANALYSIS], [DOCUMENT], [VISUAL],
 * [MEMORY].
 */
export const ALL_TAG_RE = /\[(DECISION|TODO|STATUS|RESULT|REVIEW|QUESTION|BLOCKER|RESEARCH|ANALYSIS|DOCUMENT|VISUAL|MEMORY)(?::DEPRECATE)?(?::\w+)?\]/g;

export function extractAllTags(content: string): string[] {
  const tags = new Set<string>();
  for (const m of content.matchAll(ALL_TAG_RE)) tags.add(m[1]);
  return Array.from(tags);
}

/**
 * Extract a [MEMORY] block from Archivist's output. Returns the structured
 * fields if parseable, null otherwise. Used by the server to append to
 * server/data/memory/<scope>.md.
 */
export type MemoryEntry = {
  scope: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  confidence: "high" | "medium" | "low";
  source: { messageIds: string[]; agentIds: string[] };
  supersedes?: string;
};

const MEMORY_BLOCK_RE = /\[MEMORY\]\s*\n([\s\S]*?)(?=\n\[(?!MEMORY)|$)/;

export function parseMemoryEntry(content: string): MemoryEntry | null {
  const m = content.match(MEMORY_BLOCK_RE);
  if (!m) return null;
  const body = m[1];

  const get = (key: string): string | undefined => {
    // Try "key: value" on a single line, or "key:\n  value..." block.
    // Skip the single-line path when the line is just "key: |" (YAML
    // block scalar indicator) — fall through to multi-line block match.
    const single = new RegExp(`^${key}:\\s+([^|\\s\\n][^\\n]*)$`, "m");
    const s = body.match(single);
    if (s && s[1].trim().length > 0) return s[1].trim();
    const yamlBlock = new RegExp(`^${key}:\\s*\\|[ \\t]*\\n((?:[ \\t][^\\n]*\\n?)+)`, "m");
    const yb = body.match(yamlBlock);
    if (yb) return yb[1].replace(/^[ \t]+/gm, "").trim();
    const block = new RegExp(`^${key}:\\s*\\n((?:[ \\t][^\\n]*\\n?)+)`, "m");
    const b = body.match(block);
    if (b) return b[1].replace(/^[ \t]+/gm, "").trim();
    return undefined;
  };

  const scope = get("scope");
  const category = get("category");
  const title = get("title");
  const contentVal = get("content");
  const confidenceRaw = get("confidence");
  const supersedes = get("supersedes");
  if (!scope || !category || !title || !contentVal) return null;

  // tags: [<tag1>, <tag2>] — split on comma, strip brackets/braces
  const tagsRaw = get("tags") ?? "";
  const tags = tagsRaw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter((t) => t.length > 0);

  // source: accept both flat (`source.messageIds: [...]`) and nested
  // YAML (`source:\n  messageIds: [...]`) forms. Nested form is friendlier
  // for archivist to write by hand.
  const findNested = (parent: string, child: string): string => {
    // Match an indented `child:` line anywhere under a `parent:` block.
    // The body might have other blocks before/after, so use lookbehind-
    // like anchoring: scan for `parent:` block, then look for indented
    // `child:` within the next 4 lines.
    const re = new RegExp(`^${parent}:[ \\t]*\\n(?:[ \\t]+[^\\n]+\\n?){0,4}[ \\t]+${child}:[ \\t]*([^\\n]+)`, "m");
    const m = body.match(re);
    return m ? m[1].trim() : "";
  };
  const sourceMsgRaw = get("source.messageIds") ?? findNested("source", "messageIds");
  const sourceAgentRaw = get("source.agentIds") ?? findNested("source", "agentIds");
  const sourceMsg = sourceMsgRaw.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  const sourceAgent = sourceAgentRaw.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);

  const confidence = (confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low")
    ? confidenceRaw
    : "medium";

  const entry: MemoryEntry = {
    scope,
    category,
    title,
    content: contentVal,
    tags,
    confidence,
    source: { messageIds: sourceMsg, agentIds: sourceAgent },
  };
  if (supersedes) entry.supersedes = supersedes;
  return entry;
}