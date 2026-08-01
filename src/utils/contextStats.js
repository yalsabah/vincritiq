// Aggregate token + cost stats across the messages of the current session.
//
// Each assistant message persists a `totalCost` snapshot from
// createCostAccumulator (utils/pricing.js). Items shaped like:
//   { label: 'Claude input', amount: 0.0123, detail: '4,096 tok' }
// We sum the numeric token counts back out for a context-window indicator.
//
// Claude Opus 5 has a 1,000,000-token context window — but the hard ceiling is
// the wrong number to gauge against. Anthropic doesn't bill for context-fill,
// yet a very long chat still degrades answer quality and costs more per turn,
// and at Opus pricing a 700K-token turn is expensive enough that nobody should
// reach it by accident. So the gauge and the Compact Chat prompt run off a
// deliberately conservative soft budget, not the model's actual limit.

// True model capability — exported for display, not for the gauge math.
export const CLAUDE_CONTEXT_WINDOW = 1_000_000;

// The budget the UI actually measures against. Raising this makes the app
// tolerate longer sessions before nudging the user to compact.
export const CONTEXT_SOFT_BUDGET = 200_000;

// At this fraction of the SOFT budget we surface the "Reaching context limit"
// warning + the Compact Chat button.
export const CONTEXT_WARN_AT = 0.7;

const TOKEN_RE = /([\d,]+)\s*tok/i;

function parseTokens(detail) {
  if (!detail || typeof detail !== 'string') return 0;
  const m = detail.match(TOKEN_RE);
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {Array<{ totalCost?: { items?: Array<{label:string, amount:number, detail?:string}>, total?: number } }>} messages
 * @returns {{
 *   inputTokens: number,
 *   outputTokens: number,
 *   totalTokens: number,
 *   totalCostUsd: number,
 *   contextPct: number,    // 0..1
 *   nearLimit: boolean,
 * }}
 */
export function aggregateContextStats(messages = []) {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCostUsd = 0;

  for (const m of messages) {
    const cost = m?.totalCost;
    if (!cost) continue;
    if (Number.isFinite(cost.total)) totalCostUsd += cost.total;
    const items = Array.isArray(cost.items) ? cost.items : [];
    for (const item of items) {
      const tokens = parseTokens(item.detail);
      if (!tokens) continue;
      const label = (item.label || '').toLowerCase();
      if (label.includes('output')) outputTokens += tokens;
      else if (label.includes('input') || label.includes('claude')) inputTokens += tokens;
    }
  }

  // Approximate cumulative context-fill: every turn re-sends prior text, so
  // Claude's effective context use grows with the LATEST input token count
  // (which already includes prior turns). We approximate by taking the max
  // single input from any one assistant message.
  let maxSingleInput = 0;
  for (const m of messages) {
    const items = m?.totalCost?.items;
    if (!Array.isArray(items)) continue;
    let perMsg = 0;
    for (const item of items) {
      const label = (item.label || '').toLowerCase();
      if (label.includes('output')) continue;
      perMsg += parseTokens(item.detail);
    }
    if (perMsg > maxSingleInput) maxSingleInput = perMsg;
  }

  const totalTokens = inputTokens + outputTokens;
  const contextPct = Math.min(1, maxSingleInput / CONTEXT_SOFT_BUDGET);
  const nearLimit = contextPct >= CONTEXT_WARN_AT;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    totalCostUsd,
    contextPct,
    nearLimit,
  };
}
