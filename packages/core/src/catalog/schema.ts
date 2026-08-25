/**
 * The agent-readable catalog.
 *
 * Shape follows ACP/UCP conventions — identifiers, price, availability,
 * variants, policies — plus AOCF-style per-product agent terms, plus one
 * addition. AOCF's protocol enum lists `mpp`, `acp`, `ap2`, `x402`, `kya-pay`
 * and the Visa and Mastercard programmes, and no UPI at all. We add `upi-uap`,
 * with mandate semantics mirroring UPI Circle's delegated, spending-capped
 * authority — the model NPCI's UAP is being built on.
 *
 * Every extracted field carries its own provenance: where it came from, the
 * snippet it came from, when it was read, and how confident the extractor was.
 * That last number is not decoration. `unit_cost_inr` confidence is wired
 * directly into discount authority — the agent may not discount what it is not
 * certain it can afford to discount. Uncertainty in the data layer propagates
 * into the permission layer.
 */

import { z } from 'zod';
import { rupeesToPaise, type Paise } from '../money.js';

export const ProvenanceSchema = z.object({
  source_url: z.string().min(1),
  /** The text this value was read from, verbatim. */
  snippet: z.string(),
  crawled_at: z.string(),
  confidence: z.number().min(0).max(1),
});

export type Provenance = z.infer<typeof ProvenanceSchema>;

/** A value together with the evidence for it. */
export function extracted<T extends z.ZodType>(value: T) {
  return z.object({ value, provenance: ProvenanceSchema });
}

export interface Extracted<T> {
  readonly value: T;
  readonly provenance: Provenance;
}

export const AVAILABILITY = ['in_stock', 'out_of_stock', 'preorder', 'discontinued'] as const;
export type Availability = (typeof AVAILABILITY)[number];

/**
 * AOCF's protocol enum plus `upi-uap`.
 *
 * The omission is the point: an agent-commerce format published without any UPI
 * option is a format that cannot describe the rails most Indian merchants
 * actually settle on.
 */
export const PROTOCOLS = [
  'mpp',
  'acp',
  'ap2',
  'x402',
  'kya-pay',
  'visa-tap',
  'mastercard-agent-pay',
  'upi-uap',
] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** AOCF-style per-product agent terms: what an agent may do with this item. */
export const AgentTermsSchema = z.object({
  agent_purchasable: z.boolean(),
  requires_human_confirmation: z.boolean(),
  max_quantity_per_order: z.number().int().min(1),
  returns_window_days: z.number().int().min(0),
  protocols: z.array(z.enum(PROTOCOLS)).min(1),
});

export type AgentTerms = z.infer<typeof AgentTermsSchema>;

export const CatalogEntrySchema = z.object({
  sku: z.string().min(1),
  title: extracted(z.string().min(1)),
  description: extracted(z.string()).optional(),
  list_price_inr: extracted(z.number().nonnegative()),
  /**
   * Unit cost. The field discount authority hangs off — a discount that eats
   * into unknown margin is a discount nobody can say was affordable.
   */
  unit_cost_inr: extracted(z.number().nonnegative()),
  availability: extracted(z.enum(AVAILABILITY)),
  variant_of: z.string().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  agent_terms: AgentTermsSchema,
});

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const CatalogSchema = z.object({
  merchant_id: z.string().min(1),
  source_url: z.string().min(1),
  extracted_at: z.string(),
  entries: z.array(CatalogEntrySchema),
});

export type Catalog = z.infer<typeof CatalogSchema>;

/**
 * What the gate needs to price a SKU. Deliberately narrow: the gate should not
 * have to know what a variant or a returns window is in order to decide whether
 * a discount is affordable.
 */
export interface SkuPricing {
  readonly sku: string;
  readonly listPrice: Paise;
  readonly unitCost: Paise;
  /**
   * Confidence in the unit cost specifically — not an average across the
   * record. A perfectly-read title does not make a guessed cost trustworthy, and
   * averaging would let confident fields launder an unconfident one.
   */
  readonly marginConfidence: number;
  readonly availability: Availability;
  readonly agentPurchasable: boolean;
  readonly maxQuantityPerOrder: number;
}

export function pricingOf(entry: CatalogEntry): SkuPricing {
  return {
    sku: entry.sku,
    listPrice: rupeesToPaise(entry.list_price_inr.value),
    unitCost: rupeesToPaise(entry.unit_cost_inr.value),
    marginConfidence: entry.unit_cost_inr.provenance.confidence,
    availability: entry.availability.value,
    agentPurchasable: entry.agent_terms.agent_purchasable,
    maxQuantityPerOrder: entry.agent_terms.max_quantity_per_order,
  };
}

export function findEntry(catalog: Catalog, sku: string): CatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.sku === sku);
}

/**
 * The lowest confidence anywhere in a record.
 *
 * Used for display and for onboarding review, so a merchant confirming an
 * extracted catalog sees the weakest link rather than a reassuring average.
 */
export function weakestConfidence(entry: CatalogEntry): number {
  const fields: Array<Extracted<unknown> | undefined> = [
    entry.title,
    entry.description,
    entry.list_price_inr,
    entry.unit_cost_inr,
    entry.availability,
  ];
  return fields.reduce<number>(
    (lowest, field) => (field === undefined ? lowest : Math.min(lowest, field.provenance.confidence)),
    1,
  );
}
