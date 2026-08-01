// Per-analysis cost accounting — developer-facing only.
//
// Numbers here are *estimates* tuned to the public price lists at time of
// writing. They're useful for spotting which calls are eating margin, not for
// invoice-grade accuracy. Update when:
//   - We swap Claude models
//   - Anthropic changes pricing
//   - Tripo3D / VinAudit / Vincario change pricing
//
// All prices are in USD.

// ─── Pricing constants ────────────────────────────────────────────────────────

// Claude Opus 5 (claude-opus-5). Per million tokens.
// Keep in sync with MODEL in src/utils/claudeApi.js.
export const CLAUDE_PRICING = {
  inputPerMTok: 5.00,
  outputPerMTok: 25.00,
  // Prompt caching reads are ~10% of input cost; cache writes are 1.25× input.
  cachedReadPerMTok: 0.50,
  cacheWritePerMTok: 6.25,
};

// Per-call fixed costs for non-token APIs.
export const FIXED_COSTS = {
  vincario_decode: 0.10, // Vincario VIN decode (paid tier)
  vinaudit_market: 0.07, // VinAudit market value lookup
  vinaudit_image:  0.05, // VinAudit images endpoint (stock photo lookup)
  tripo3d_image:   0.30, // Tripo3D image-to-3D generation
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function priceClaudeUsage(usage) {
  if (!usage || typeof usage !== 'object') return { amount: 0, items: [] };

  const inTok       = Number(usage.input_tokens || 0);
  const outTok      = Number(usage.output_tokens || 0);
  const cachedRead  = Number(usage.cache_read_input_tokens || 0);
  const cachedWrite = Number(usage.cache_creation_input_tokens || 0);

  const items = [];
  let total = 0;

  const push = (label, tokens, perM, sub) => {
    if (tokens <= 0) return;
    const amount = (tokens / 1_000_000) * perM;
    items.push({ label, amount, detail: `${tokens.toLocaleString()} tok${sub ? ' · ' + sub : ''}` });
    total += amount;
  };

  push('Claude input',              inTok,       CLAUDE_PRICING.inputPerMTok,       null);
  push('Claude input (cache hit)',  cachedRead,  CLAUDE_PRICING.cachedReadPerMTok,  '90% off');
  push('Claude input (cache write)',cachedWrite, CLAUDE_PRICING.cacheWritePerMTok,  '1.25× input');
  push('Claude output',             outTok,      CLAUDE_PRICING.outputPerMTok,      null);

  return { amount: total, items };
}

// Cost accumulator — accepts repeated additions, snapshots into the
// JSON-serializable shape we persist on each assistant message.
//
// Returned snapshot:
//   {
//     total: 0.123,
//     items: [{ label, amount, detail, at }],
//     updatedAt: <ms epoch>,
//   }
export function createCostAccumulator() {
  const items = [];
  let total = 0;

  const add = (label, amount, detail = null) => {
    if (!Number.isFinite(amount) || amount <= 0) return;
    items.push({
      label,
      amount: Number(amount.toFixed(6)),
      detail,
      at: Date.now(),
    });
    total = Number((total + amount).toFixed(6));
  };

  return {
    add,
    addClaudeUsage(usage) {
      const { items: rows } = priceClaudeUsage(usage);
      for (const r of rows) add(r.label, r.amount, r.detail);
    },
    snapshot() {
      return {
        total,
        items: items.map(i => ({ ...i })),
        updatedAt: Date.now(),
      };
    },
  };
}

// USD formatter — uses 4 decimal places under a cent so sub-penny costs
// (small Claude calls, cache hits) are visible instead of rounding to $0.00.
export function formatUsd(n) {
  if (!Number.isFinite(n)) return '$0.0000';
  if (n >= 1)    return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}
