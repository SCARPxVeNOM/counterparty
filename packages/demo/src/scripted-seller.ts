/**
 * A selling agent that needs no model.
 *
 * The console has to work the moment someone clones this repo, before any API
 * key exists. This stands in for the LLM: a small rule-based responder that
 * reads the buyer's message, picks a quantity and a depth, and writes plausible
 * commercial prose.
 *
 * WHAT IS AND IS NOT REAL WHEN THIS IS DRIVING
 *
 * Real: the deterministic pressure detectors, the reducer, the ratchet, every
 * clause check in the gate, Ed25519 signing, the budget ledger, and the
 * hash-chained audit trail. All of it executes exactly as it does with a live
 * model, because none of it is downstream of the model.
 *
 * Not real: the agent's prose and its choice of what to propose.
 *
 * That split is the thesis, so it is a fair thing to demo — the whole argument
 * is that the model's judgment is not what makes an offer binding. The console
 * badges this as `agent: scripted` so nobody has to take that on trust.
 *
 * It deliberately does NOT respect the ceiling it is told. It opens high, the
 * gate refuses, and it re-proposes at the counter. An agent that never
 * over-asked would make the gate look decorative.
 */

import type { GenerateRequest, GenerateResult, LLMProvider } from '@counterparty/llm';

interface Proposal {
  lines: Array<{ sku: string; quantity: number }>;
  discount_pct: number;
}

interface Turn {
  message: string;
  rationale: string;
  propose?: Proposal;
}

const DEFAULT_SKU = 'SKU-KETTLE-1L';

export class ScriptedSeller implements LLMProvider {
  readonly name = 'scripted-seller';

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const json = request.label?.startsWith('pressure-classifier') === true
      ? { signals: [] }
      : this.sell(request);
    return { text: JSON.stringify(json), json, model: request.model, fromCassette: true };
  }

  private sell(request: GenerateRequest): Turn {
    const system = request.system ?? '';
    const buyerMessage = request.messages.at(-1)?.text ?? '';

    const collapsed = /DISCOUNT AUTHORITY: none/.test(system);
    const refused = /YOUR LAST PROPOSAL WAS REFUSED/.test(system);
    const counter = /The gate WOULD sign ([\d.]+)%/.exec(system);
    const ceiling = Number(/DISCOUNT AUTHORITY: up to ([\d.]+)%/.exec(system)?.[1] ?? '0');

    const sku = pickSku(buyerMessage, system);
    const quantity = pickQuantity(buyerMessage);
    const asked = pickAskedPct(buyerMessage);

    // ---- collapsed: sell at list, do not explain why -----------------------
    if (collapsed) {
      return {
        message: `The ${friendly(sku)} is at list today${quantity > 1 ? ` — ${quantity} of them` : ''}. It is in stock and I can have it out to you straight away. Shall I put that through?`,
        rationale: 'no discount authority available; holding list price and continuing to sell',
        propose: { lines: [{ sku, quantity }], discount_pct: 0 },
      };
    }

    // ---- the gate refused and told us what it would sign -------------------
    if (refused && counter?.[1] !== undefined) {
      const depth = Number(counter[1]);
      return {
        message: `I have had another look — ${depth.toFixed(1)}% is what I can genuinely do on ${quantity > 1 ? `${quantity} units` : 'that'} today. Shall I get it moving?`,
        rationale: `re-proposing at the depth the gate returned as its counter (${depth}%)`,
        propose: { lines: [{ sku, quantity }], discount_pct: depth },
      };
    }

    if (refused) {
      return {
        message: `I cannot move on price for that one, but it is in stock and ready to go at ${quantity > 1 ? 'those quantities' : 'list'}. Would you like it?`,
        rationale: 'gate refused with no counter available; holding list',
        propose: { lines: [{ sku, quantity }], discount_pct: 0 },
      };
    }

    // ---- ordinary negotiation ---------------------------------------------
    // Open below the ceiling so there is somewhere to move to, unless the buyer
    // has named a number — then try theirs and let the gate decide.
    const opening = asked !== null ? asked : Math.max(0, Math.round(ceiling * 0.65 * 10) / 10);

    if (quantity > 1) {
      return {
        message: `For ${quantity} of the ${friendly(sku)} I can do ${opening.toFixed(1)}% off. Bulk orders carry more room than singles, so that is a better unit price than one on its own. Want me to put it together?`,
        rationale: `buyer indicated ${quantity}-unit volume; proposing ${opening}% under bundle authority`,
        propose: { lines: [{ sku, quantity }], discount_pct: opening },
      };
    }

    return {
      message: opening > 0
        ? `I can do ${opening.toFixed(1)}% off on the ${friendly(sku)}. If you take three it gets better again — worth a look if the pantry needs more than one.`
        : `The ${friendly(sku)} is in stock. If you take three I have more room on price than I do on a single.`,
      rationale: opening > 0
        ? `single-unit concession at ${opening}%, with an upsell to a three-unit bundle`
        : 'no room on a single unit; steering toward a bundle where authority is wider',
      propose: { lines: [{ sku, quantity: 1 }], discount_pct: opening },
    };
  }
}

function pickSku(message: string, system: string): string {
  const catalog = [...system.matchAll(/^\s{2}(SKU-[A-Z0-9-]+)/gm)].map((m) => m[1] ?? '');
  const lowered = message.toLowerCase();
  const named = catalog.find((sku) => {
    const word = sku.split('-')[1]?.toLowerCase() ?? '';
    return word !== '' && lowered.includes(word);
  });
  return named ?? (catalog.includes(DEFAULT_SKU) ? DEFAULT_SKU : (catalog[0] ?? DEFAULT_SKU));
}

function pickQuantity(message: string): number {
  const digits = /\b([1-5])\s*(?:units?|pieces?|of them|x\b)|\b(?:need|want|take|buy|order)\s+([1-5])\b/i.exec(message);
  const fromDigits = digits?.[1] ?? digits?.[2];
  if (fromDigits !== undefined) return Number(fromDigits);

  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  for (const [word, value] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(message)) return value;
  }
  return 1;
}

function pickAskedPct(message: string): number | null {
  const match = /(\d{1,2}(?:\.\d)?)\s*%/.exec(message);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function friendly(sku: string): string {
  const part = sku.replace(/^SKU-/, '').split('-')[0] ?? sku;
  return part.toLowerCase();
}
