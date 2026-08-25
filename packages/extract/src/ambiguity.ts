/**
 * Confidence, derived from the source rather than self-reported.
 *
 * The obvious way to score extraction confidence is to ask the model how sure
 * it is. That number is worthless. Language models are badly calibrated at
 * self-assessment, and worse, the field this system hangs discount authority on
 * — unit cost — is exactly the field a model is most likely to be confidently
 * wrong about, because a plausible-looking number is always available on the
 * page.
 *
 * So confidence is computed the same way pressure is: the model performs
 * perception, and deterministic code owns the score. Here the code counts
 * COUNTABLE AMBIGUITY in the source — how many competing prices are on the
 * page, whether there is a struck-through MRP, whether a "from ₹X" teaser
 * refers to a different variant, whether the cost figure is marked stale. Every
 * penalty below corresponds to something a human can point at in the HTML.
 *
 * That makes the number falsifiable. "This SKU scored 0.25 because the page
 * carries four competing prices and a stale cost note" is an argument. "The
 * model felt unsure" is not.
 */

export const AMBIGUITY_KINDS = [
  'competing_price',
  'struck_through_mrp',
  'from_teaser',
  'variant_table',
  'offer_copy_price',
  'stale_cost_marker',
  'cost_absent',
  'price_absent',
] as const;

export type AmbiguityKind = (typeof AMBIGUITY_KINDS)[number];

/**
 * How much each observation costs.
 *
 * Calibrated so a clean page lands near 1.0 and a page carrying several
 * contradictory prices falls below any sensible `min_margin_confidence`. A
 * stale cost marker is near-fatal on its own: a cost the merchant themselves
 * flagged as unverified is not a basis for discounting.
 */
export const AMBIGUITY_PENALTIES: Readonly<Record<AmbiguityKind, number>> = {
  cost_absent: 0.95,
  price_absent: 0.95,
  stale_cost_marker: 0.75,
  variant_table: 0.35,
  from_teaser: 0.3,
  offer_copy_price: 0.3,
  competing_price: 0.25,
  struck_through_mrp: 0.2,
};

export interface Ambiguity {
  readonly kind: AmbiguityKind;
  /** The text in the source that produced this, verbatim. */
  readonly evidence: string;
  readonly note: string;
}

/**
 * Extraction is never certain, even from a clean page. A ceiling below 1.0
 * keeps the difference between "read from a tidy storefront" and "typed in by
 * the merchant" visible in the number.
 */
export const EXTRACTION_CEILING = 0.96;

/**
 * Confidence as the product of surviving certainty.
 *
 * Each ambiguity multiplies what is left, so the score is monotonically
 * non-increasing in the number of problems found and stays in (0, 1] without
 * clamping. Same shape as the pressure reducer, pointing the other way.
 */
export function confidenceFrom(ambiguities: readonly Ambiguity[]): number {
  let surviving = EXTRACTION_CEILING;
  for (const each of ambiguities) {
    surviving *= 1 - AMBIGUITY_PENALTIES[each.kind];
  }
  return Number(surviving.toFixed(4));
}

const RUPEES = /₹\s?([\d,]+(?:\.\d{1,2})?)/g;

/** Every rupee amount in a fragment, deduplicated, in document order. */
export function rupeeAmounts(html: string): number[] {
  const found: number[] = [];
  for (const match of html.matchAll(RUPEES)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const value = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(value) && value > 0 && !found.includes(value)) found.push(value);
  }
  return found;
}

/** Ambiguities affecting the LIST PRICE reading. */
export function priceAmbiguities(html: string): Ambiguity[] {
  const found: Ambiguity[] = [];
  const prices = rupeeAmounts(html);

  if (prices.length === 0) {
    return [{ kind: 'price_absent', evidence: '', note: 'no rupee amount found on the page' }];
  }

  const struck = /<s>\s*(₹[\d,]+)\s*<\/s>|class="[^"]*\bmrp\b[^"]*"/i.exec(html);
  if (struck !== null) {
    found.push({
      kind: 'struck_through_mrp',
      evidence: struck[0].slice(0, 80),
      note: 'a struck-through MRP sits alongside the selling price',
    });
  }

  const teaser = /\bfrom\s*₹\s?[\d,]+/i.exec(html);
  if (teaser !== null) {
    found.push({
      kind: 'from_teaser',
      evidence: teaser[0],
      note: 'a "from" price refers to the cheapest variant, which may not be this SKU',
    });
  }

  const variants = /<table[^>]*class="[^"]*variant/i.test(html);
  if (variants) {
    const block = /<table[^>]*class="[^"]*variant[\s\S]*?<\/table>/i.exec(html)?.[0] ?? '';
    const variantPrices = rupeeAmounts(block);
    if (variantPrices.length > 1) {
      found.push({
        kind: 'variant_table',
        evidence: variantPrices.map((p) => `₹${p}`).join(', '),
        note: `${variantPrices.length} variant prices, none marked as the default`,
      });
    }
  }

  const offer = /(?:offer|festival|deal|flat)[^<]{0,60}₹\s?[\d,]+/i.exec(html);
  if (offer !== null) {
    found.push({
      kind: 'offer_copy_price',
      evidence: offer[0].trim(),
      note: 'promotional copy names a price that contradicts the listed one',
    });
  }

  // Every price beyond the first that is not already explained by a signal above.
  const explained = found.length;
  const unexplained = Math.max(0, prices.length - 1 - explained);
  for (let i = 0; i < unexplained; i += 1) {
    found.push({
      kind: 'competing_price',
      evidence: prices.map((p) => `₹${p}`).join(', '),
      note: `${prices.length} distinct prices on one page`,
    });
  }

  return found;
}

/** Ambiguities affecting the UNIT COST reading — the field authority hangs on. */
export function costAmbiguities(html: string): Ambiguity[] {
  const cost = /data-unit-cost="(\d+)"/i.exec(html);
  if (cost === null) {
    return [
      {
        kind: 'cost_absent',
        evidence: '',
        note: 'no unit cost anywhere in the page — margin cannot be established',
      },
    ];
  }

  const note = /data-cost-note="([^"]*)"/i.exec(html)?.[1] ?? '';
  if (/verify|stale|last updated|out of date|check|changed/i.test(note)) {
    return [
      {
        kind: 'stale_cost_marker',
        evidence: note,
        note: 'the merchant flagged this cost as unverified',
      },
    ];
  }

  return [];
}
