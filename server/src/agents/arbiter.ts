export type ArbiterDecision = {
  pick: string;
  reason: string;
  alternatives: string[];
};

const PRIORITY: Record<string, number> = {
  forge: 3,
  lens: 2,
  echo: 1,
  atlas: 4,
  user: 5,
};

export function resolveConflict(mentions: Array<{ id: string; name: string }>, content: string): ArbiterDecision | null {
  if (mentions.length === 0) return null;
  if (mentions.length === 1) return { pick: mentions[0].id, reason: "single-mention", alternatives: [] };

  const sorted = [...mentions].sort((a, b) => (PRIORITY[b.id] ?? 0) - (PRIORITY[a.id] ?? 0));
  return {
    pick: sorted[0].id,
    reason: "priority-rank",
    alternatives: sorted.slice(1).map((m) => m.id),
  };
}
