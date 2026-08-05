// Vehicle-finder agent.
//
// Turns a free-text request ("find me a black 2023 Audi S5 Premium Plus under
// 50k miles, around $35k, in Arizona") into structured Auto.dev filters, runs
// the search, and talks back conversationally. It's a thin agent: one Claude
// call extracts intent, then the existing /api/listings pipeline does the
// fetch. The model never sees inventory — it only interprets the request and
// narrates the result.
//
// Two exports the UI uses:
//   interpretRequest(text, history) → { reply, filters, clarifying }
//   runAgentSearch(filters, signal) → { listings, total }

import {
  EARLIEST_YEAR,
  LATEST_YEAR,
  PRICE_CEILING,
  MILEAGE_CEILING,
} from './listings';

// Kept small and fast — this is an extraction task, not an essay. Opus 5 with
// low effort answers in ~1-2s, which is what makes the agent feel responsive.
const AGENT_MODEL = 'claude-opus-5';

// Auto.dev inventory contains rows with junk prices — $85, $199, $6 — which
// are lease/finance payment figures or placeholders that leaked into the
// price field. Harmless in a freshest-first grid, but "cheapest first" (the
// natural sort for a budget request) floats every one of them to the top. A
// floor drops them: nobody is selling a real car for under this.
const PRICE_FLOOR = 1500;

const SYSTEM = `You are VinCritiq's Vehicle Finder — a friendly agent that helps someone find a specific used car from live US dealer inventory.

Your job each turn:
1. Read the user's request (and the conversation so far) and figure out what car they want.
2. Reply in 1-2 short, warm sentences saying what you're searching for — like a knowledgeable friend, not a form. No bullet lists, no headings.
3. Emit a single <FILTERS>...</FILTERS> block with the structured search. Put it at the very end.

The <FILTERS> block is strict JSON with EXACTLY these keys (use null when the user didn't specify or you're unsure):
{
  "make": string|null,          // e.g. "Audi" — proper make name
  "model": string|null,         // e.g. "S5" — bare model, no trim
  "trim": string|null,          // e.g. "Premium Plus"
  "yearMin": number|null,       // inclusive
  "yearMax": number|null,       // inclusive; for a single year set min==max
  "priceMin": number|null,      // USD
  "priceMax": number|null,      // USD
  "mileageMax": number|null,    // miles
  "color": string|null,         // exterior color word, e.g. "black"
  "state": string|null,         // 2-letter US state code, e.g. "AZ" for Arizona
  "zip": string|null,           // 5-digit US ZIP if the user gave one
  "bodyStyle": string|null,     // one of "Car","SUV","Truck","Van" if clearly implied, else null
  "cpo": boolean|null,          // true only if they ask for certified pre-owned
  "clarifying": boolean         // true if your reply is a question because the request is too vague to search
}

Rules:
- "around $X" or "about $X" → a range: priceMin ≈ X*0.9, priceMax ≈ X*1.15. "under $X"/"less than $X" → priceMax only. "over $X" → priceMin only.
- "less than 50k miles" → mileageMax 50000. "low miles"/"low mileage" with no number → mileageMax 60000 (a reasonable low-mileage cutoff).
- Map state names to codes ("Arizona"→"AZ", "Texas"→"TX"). A city without a state → leave state null and mention you searched nationwide.
- If the user only says something vague ("a nice cheap car", "something reliable") with no make/model/type, set clarifying:true and ask ONE friendly question to narrow it down — don't guess a random car.
- On a follow-up, MERGE with what you already knew: "make it under $30k" keeps the previous make/model and just changes price.
- You only find vehicles. If asked for anything non-vehicle, set clarifying:true and say you only help find cars.

Keep the prose before the block genuinely short. The UI shows the matching cars beneath your reply, so don't describe cars you haven't seen.`;

// Pull the assistant's prose + the <FILTERS> JSON out of one message.
function parseAgentMessage(text) {
  const raw = String(text || '');
  const m = raw.match(/<FILTERS>([\s\S]*?)<\/FILTERS>/);
  let filters = null;
  if (m) {
    try {
      filters = JSON.parse(m[1].trim());
    } catch {
      filters = null;
    }
  }
  // The reply is everything before the block, cleaned up.
  const reply = raw.replace(/<FILTERS>[\s\S]*?<\/FILTERS>/, '').trim();
  return { reply, filters };
}

/**
 * One conversational turn. Sends the running history + the new message to
 * Claude and returns the agent's reply plus the extracted filters.
 *
 * @param {string} text     the user's latest message
 * @param {Array<{role:'user'|'assistant', text:string}>} history prior turns
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ reply: string, filters: object|null, clarifying: boolean }>}
 */
export async function interpretRequest(text, history = [], signal) {
  const messages = [];
  for (const m of history) {
    const t = (m?.text || '').trim();
    if ((m?.role === 'user' || m?.role === 'assistant') && t) {
      messages.push({ role: m.role, content: t });
    }
  }
  messages.push({ role: 'user', content: String(text || '').trim() || 'Find me a car.' });

  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: AGENT_MODEL,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: SYSTEM,
      messages,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Agent request failed (${res.status})`);
  }

  const data = await res.json();
  // Non-streaming Opus 5 returns content blocks; the visible answer is the
  // text block (a thinking block may precede it).
  const textOut = Array.isArray(data?.content)
    ? data.content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
    : '';

  const { reply, filters } = parseAgentMessage(textOut);
  const clarifying = Boolean(filters?.clarifying) || !filters;
  return {
    reply: reply || (clarifying ? 'Could you tell me a bit more about the car you want?' : 'Here’s what I found.'),
    filters: clarifying ? null : filters,
    clarifying,
  };
}

/**
 * Map the agent's extracted filters onto the Find panel's own search state, so
 * results render in the main grid + map (not inside the agent modal). The panel
 * then runs its normal debounced search — the agent is just a fancy way to fill
 * the filters. Returns the exact setter values the panel needs.
 *
 * @returns {{ q, priceRange, mileageRange, yearRange, bodyStyle, cpoOnly, state, color, zip, radius, sort }}
 */
export function agentFiltersToPanelState(f) {
  const q = [f.make, f.model, f.trim].filter(Boolean).join(' ').trim();

  const priceMax = Number.isFinite(f.priceMax) ? f.priceMax : PRICE_CEILING;
  const hasPriceMax = priceMax < PRICE_CEILING;
  // Floor the low end only when there's an actual ceiling — otherwise cheapest-
  // first would lead with the $85 junk-priced rows in the feed.
  const priceMin = hasPriceMax
    ? Math.max(Number.isFinite(f.priceMin) ? f.priceMin : 0, PRICE_FLOOR)
    : Number.isFinite(f.priceMin) ? f.priceMin : 0;

  // Sort by intent: a specific make+model with a budget wants cheapest-first; a
  // broad "SUV under $25k" wants fresh, representative inventory (cheapest-first
  // on a broad set surfaces salvage/high-mile outliers, not real buys).
  const targeted = Boolean(f.make && f.model);
  const zip = /^\d{5}$/.test(String(f.zip || '')) ? String(f.zip) : '';

  return {
    q,
    priceRange: [priceMin, priceMax],
    mileageRange: [0, Number.isFinite(f.mileageMax) ? f.mileageMax : MILEAGE_CEILING],
    yearRange: [
      Number.isFinite(f.yearMin) ? f.yearMin : EARLIEST_YEAR,
      Number.isFinite(f.yearMax) ? f.yearMax : LATEST_YEAR,
    ],
    bodyStyle: ['Car', 'SUV', 'Truck', 'Van'].includes(f.bodyStyle) ? f.bodyStyle : '',
    cpoOnly: f.cpo === true,
    state: f.state || '',
    color: f.color || '',
    zip,
    radius: zip ? 100 : 'nationwide',
    sort: targeted ? 'price.asc' : 'updatedAt.desc',
  };
}

// A short, human summary of the filters — shown as a chip row under the
// agent's reply so the user can see exactly what was searched.
export function describeFilters(f) {
  if (!f) return [];
  const bits = [];
  const ymin = f.yearMin;
  const ymax = f.yearMax;
  if (ymin && ymax) bits.push(ymin === ymax ? `${ymin}` : `${ymin}–${ymax}`);
  else if (ymin) bits.push(`${ymin}+`);
  else if (ymax) bits.push(`≤${ymax}`);
  if (f.color) bits.push(f.color);
  const name = [f.make, f.model, f.trim].filter(Boolean).join(' ');
  if (name) bits.push(name);
  if (f.bodyStyle) bits.push(f.bodyStyle);
  if (Number.isFinite(f.priceMin) && Number.isFinite(f.priceMax)) bits.push(`$${Math.round(f.priceMin / 1000)}k–$${Math.round(f.priceMax / 1000)}k`);
  else if (Number.isFinite(f.priceMax)) bits.push(`≤$${Math.round(f.priceMax / 1000)}k`);
  else if (Number.isFinite(f.priceMin)) bits.push(`≥$${Math.round(f.priceMin / 1000)}k`);
  if (Number.isFinite(f.mileageMax)) bits.push(`≤${Math.round(f.mileageMax / 1000)}k mi`);
  if (f.cpo) bits.push('CPO');
  if (f.state) bits.push(f.state);
  else if (f.zip) bits.push(f.zip);
  return bits;
}
