/**
 * The catalog as a buyer sees it.
 *
 * A merchant's catalog record and a merchant's *published* catalog are not the
 * same document, and the difference is not cosmetic. `SkuPricing` carries
 * `unitCost` and `marginConfidence` — what the merchant paid, and how sure it is
 * about that. Both are wired directly into discount authority, and neither has
 * any business leaving the building. A published feed that leaked unit cost
 * would hand every buyer's agent the merchant's floor, which is the one number
 * that makes negotiation possible at all.
 *
 * So the published view is built by *listing* what goes in, never by removing
 * what should not. A field added to `SkuPricing` next month appears in the
 * published feed only if someone writes it into this function on purpose. The
 * opposite construction — spread the record, delete the secrets — leaks by
 * default the moment anyone adds a field, which is the wrong way round for the
 * one boundary in this system that faces outward.
 *
 * There is a test that asserts no cost survives, and a second that asserts the
 * serialized feed contains no number equal to any unit cost.
 *
 * `envelope_id` is what makes the feed self-describing. It tells a buyer which
 * selling mandate governs purchases from this catalog, so discovery leads to
 * verification without anyone having to be told out of band where to look.
 */

import type { Availability, Protocol, SkuPricing } from './schema';

export const PUBLISHED_CATALOG_VERSION = 'counterparty/published-catalog/1' as const;

export interface PublishedEntry {
  readonly sku: string;
  readonly title: string;
  readonly list_price_inr: number;
  readonly currency: 'INR';
  readonly availability: Availability;
  /** AOCF's question: not "can I find this" but "am I allowed to buy it". */
  readonly agent_purchasable: boolean;
  readonly max_quantity_per_order: number;
  readonly protocols: readonly Protocol[];
}

export interface PublishedCatalog {
  readonly version: typeof PUBLISHED_CATALOG_VERSION;
  readonly merchant_id: string;
  /** The selling mandate that governs purchases made from this catalog. */
  readonly envelope_id: string;
  readonly published_at: string;
  readonly entries: readonly PublishedEntry[];
}

export interface PublishOptions {
  readonly merchantId: string;
  readonly envelopeId: string;
  readonly publishedAt?: Date;
  /** Human titles, by SKU. Absent titles fall back to the SKU itself. */
  readonly titles?: Readonly<Record<string, string>>;
  /** Which agent-commerce protocols this merchant will settle on. */
  readonly protocols?: readonly Protocol[];
}

/**
 * Build the public feed from the merchant's own records.
 *
 * Out-of-stock and non-agent-purchasable items are still listed. Omitting them
 * would be tidier and would tell a buyer's agent nothing about *why* it cannot
 * buy something, leaving it to retry a discontinued SKU forever. A catalog that
 * says "here, and no" is more useful to an agent than one that silently omits.
 */
export function publishCatalog(
  pricing: Iterable<SkuPricing>,
  options: PublishOptions,
): PublishedCatalog {
  const protocols = options.protocols ?? (['acp', 'ap2', 'upi-uap'] as const);

  return {
    version: PUBLISHED_CATALOG_VERSION,
    merchant_id: options.merchantId,
    envelope_id: options.envelopeId,
    published_at: (options.publishedAt ?? new Date()).toISOString(),
    entries: [...pricing].map((sku) => ({
      sku: sku.sku,
      title: options.titles?.[sku.sku] ?? sku.sku,
      list_price_inr: sku.listPrice / 100,
      currency: 'INR' as const,
      availability: sku.availability,
      agent_purchasable: sku.agentPurchasable,
      max_quantity_per_order: sku.maxQuantityPerOrder,
      protocols,
    })),
  };
}

/** Whether an agent may buy this at all, before price enters into it. */
export function isBuyable(entry: PublishedEntry, protocols: readonly Protocol[]): boolean {
  return (
    entry.agent_purchasable &&
    entry.availability === 'in_stock' &&
    entry.protocols.some((p) => protocols.includes(p))
  );
}
