/**
 * The published catalog, and the one thing it must never contain.
 *
 * `unitCost` is what the merchant paid. It is wired straight into discount
 * authority, so a buyer's agent holding it knows exactly how far the seller can
 * be pushed — and negotiation stops being negotiation. The last test here does
 * not check a field name; it serializes the whole feed and looks for the number.
 */

import { describe, expect, it } from 'vitest';
import { publishCatalog, isBuyable } from '../../src/catalog/published';
import { rupeesToPaise } from '../../src/money';
import type { SkuPricing } from '../../src/catalog/schema';

const KETTLE: SkuPricing = {
  sku: 'SKU-KETTLE-1L',
  listPrice: rupeesToPaise(4990),
  unitCost: rupeesToPaise(3400),
  marginConfidence: 0.94,
  availability: 'in_stock',
  agentPurchasable: true,
  maxQuantityPerOrder: 5,
};

const GIFT_CARD: SkuPricing = {
  ...KETTLE,
  sku: 'SKU-GIFTCARD-1000',
  agentPurchasable: false,
};

const SOLD_OUT: SkuPricing = {
  ...KETTLE,
  sku: 'SKU-MIXER-750',
  availability: 'out_of_stock',
};

const OPTIONS = { merchantId: 'acc_TEST0001', envelopeId: 'env_test', publishedAt: new Date('2026-09-04T10:00:00Z') };

describe('what the feed carries', () => {
  it('states the price in rupees', () => {
    const feed = publishCatalog([KETTLE], OPTIONS);
    expect(feed.entries[0]?.list_price_inr).toBe(4990);
  });

  it('names the envelope that governs purchases from it', () => {
    // Without this a buyer has to be told out of band which mandate to verify
    // against, and discovery stops leading to verification.
    expect(publishCatalog([KETTLE], OPTIONS).envelope_id).toBe('env_test');
  });

  it('uses the SKU as the title when no title is supplied', () => {
    expect(publishCatalog([KETTLE], OPTIONS).entries[0]?.title).toBe('SKU-KETTLE-1L');
  });

  it('uses a supplied title when there is one', () => {
    const feed = publishCatalog([KETTLE], { ...OPTIONS, titles: { 'SKU-KETTLE-1L': '1L Kettle' } });
    expect(feed.entries[0]?.title).toBe('1L Kettle');
  });

  it('lists items an agent may not buy, rather than hiding them', () => {
    // A catalog that silently omits tells an agent nothing about why it cannot
    // buy something, and leaves it to retry forever.
    const feed = publishCatalog([KETTLE, GIFT_CARD, SOLD_OUT], OPTIONS);
    expect(feed.entries).toHaveLength(3);
    expect(feed.entries.find((e) => e.sku === 'SKU-GIFTCARD-1000')?.agent_purchasable).toBe(false);
    expect(feed.entries.find((e) => e.sku === 'SKU-MIXER-750')?.availability).toBe('out_of_stock');
  });
});

describe('what the feed must never carry', () => {
  it('has no unit cost field', () => {
    const entry = publishCatalog([KETTLE], OPTIONS).entries[0];
    expect(entry !== undefined && 'unit_cost_inr' in entry).toBe(false);
    expect(entry !== undefined && 'unitCost' in entry).toBe(false);
  });

  it('has no margin confidence field', () => {
    const entry = publishCatalog([KETTLE], OPTIONS).entries[0];
    expect(entry !== undefined && 'marginConfidence' in entry).toBe(false);
    expect(entry !== undefined && 'margin_confidence' in entry).toBe(false);
  });

  /**
   * The check that survives a rename.
   *
   * Asserting on field names catches today's leak. This catches the one where
   * someone adds `floor_price_inr` next month and every name-based test still
   * passes, because it looks for the *value* anywhere in the serialized feed.
   */
  it('contains no number equal to any unit cost, anywhere in the serialized feed', () => {
    const pricing = [KETTLE, GIFT_CARD, SOLD_OUT];
    const serialized = JSON.stringify(publishCatalog(pricing, OPTIONS));

    for (const sku of pricing) {
      const rupees = sku.unitCost / 100;
      expect(serialized).not.toContain(String(rupees));
      expect(serialized).not.toContain(String(sku.unitCost));
    }
  });

  it('leaks nothing when the cost happens to equal the list price', () => {
    // The degenerate case: a zero-margin SKU. The cost is not secret here
    // because it is also the price, and the test above would false-positive
    // without acknowledging it.
    const zeroMargin: SkuPricing = { ...KETTLE, sku: 'SKU-ATCOST', unitCost: KETTLE.listPrice };
    const entry = publishCatalog([zeroMargin], OPTIONS).entries[0];
    expect(entry?.list_price_inr).toBe(4990);
    expect(entry !== undefined && 'unitCost' in entry).toBe(false);
  });
});

describe('whether an agent may buy it', () => {
  const feed = publishCatalog([KETTLE, GIFT_CARD, SOLD_OUT], OPTIONS);
  const bySku = (sku: string) => feed.entries.find((e) => e.sku === sku)!;

  it('allows an in-stock, agent-purchasable item on a shared protocol', () => {
    expect(isBuyable(bySku('SKU-KETTLE-1L'), ['ap2'])).toBe(true);
  });

  it('refuses an item the merchant marked not agent-purchasable', () => {
    expect(isBuyable(bySku('SKU-GIFTCARD-1000'), ['ap2'])).toBe(false);
  });

  it('refuses an out-of-stock item', () => {
    expect(isBuyable(bySku('SKU-MIXER-750'), ['ap2'])).toBe(false);
  });

  it('refuses an item on no protocol the buyer speaks', () => {
    expect(isBuyable(bySku('SKU-KETTLE-1L'), ['x402'])).toBe(false);
  });

  it('accepts when any one protocol overlaps', () => {
    expect(isBuyable(bySku('SKU-KETTLE-1L'), ['x402', 'upi-uap'])).toBe(true);
  });
});
