import { describe, expect, it } from 'vitest';
import {
  INITIAL_PRESSURE,
  dayKeyOf,
  draftMandate,
  evaluateQuote,
  generateKeyPair,
  issueMandate,
  openBudget,
  pricingOf,
  publicKeyRef,
  rupeesToPaise,
  type SkuPricing,
} from '@counterparty/core';
import { extractCatalog, extractEntry } from '../src/extract';
import { loadFixture } from '../src/fixtures';
import { confidenceFrom, costAmbiguities, priceAmbiguities } from '../src/ambiguity';

const NOW = new Date('2026-08-25T09:00:00+05:30');

describe('a clean storefront page', () => {
  const result = extractEntry(loadFixture('kettle', NOW));

  it('reads the SKU, title and price', () => {
    expect(result.entry.sku).toBe('SKU-KETTLE-1L');
    expect(result.entry.title.value).toContain('Kettle');
    expect(result.entry.list_price_inr.value).toBe(4990);
  });

  it('reads the unit cost', () => {
    expect(result.entry.unit_cost_inr.value).toBe(3400);
  });

  it('reads availability', () => {
    expect(result.entry.availability.value).toBe('in_stock');
  });

  it('scores high confidence on both money fields', () => {
    expect(result.entry.list_price_inr.provenance.confidence).toBeGreaterThan(0.9);
    expect(result.entry.unit_cost_inr.provenance.confidence).toBeGreaterThan(0.9);
  });

  it('carries provenance on every field', () => {
    for (const field of [result.entry.title, result.entry.list_price_inr, result.entry.unit_cost_inr]) {
      expect(field.provenance.source_url).toContain('kettleandco.example');
      expect(field.provenance.crawled_at).toBe(NOW.toISOString());
      expect(field.provenance.snippet.length).toBeGreaterThan(0);
    }
  });

  it('tags the SKU with the upi-uap protocol AOCF omits', () => {
    expect(result.entry.agent_terms.protocols).toContain('upi-uap');
  });
});

describe('the messy storefront page', () => {
  const result = extractEntry(loadFixture('blender', NOW));

  it('still reads the SKU and a price', () => {
    expect(result.entry.sku).toBe('SKU-BLENDER-500');
    expect(result.entry.list_price_inr.value).toBe(3200);
  });

  /**
   * The point of the fixture. Confidence is low because the page is genuinely
   * ambiguous, and every penalty points at something a human can see in the
   * HTML — not because a number was hardcoded to make the demo work.
   */
  it('scores low confidence on the price, and says why', () => {
    const report = result.reports.find((r) => r.field === 'list_price_inr');
    expect(report?.confidence).toBeLessThan(0.5);
    const kinds = report?.ambiguities.map((a) => a.kind) ?? [];
    expect(kinds).toContain('struck_through_mrp');
    expect(kinds).toContain('from_teaser');
    expect(kinds).toContain('variant_table');
    expect(kinds).toContain('offer_copy_price');
  });

  it('scores the cost even lower, because the merchant flagged it themselves', () => {
    const report = result.reports.find((r) => r.field === 'unit_cost_inr');
    expect(report?.confidence).toBeLessThan(0.3);
    expect(report?.ambiguities[0]?.kind).toBe('stale_cost_marker');
    expect(report?.ambiguities[0]?.evidence).toContain('verify');
  });

  it('lands below the reference envelope threshold of 0.85', () => {
    expect(result.entry.unit_cost_inr.provenance.confidence).toBeLessThan(0.85);
  });
});

describe('confidence arithmetic', () => {
  it('is at the ceiling with no ambiguity', () => {
    expect(confidenceFrom([])).toBe(0.96);
  });

  it('never increases when an ambiguity is added', () => {
    const problems = priceAmbiguities(loadFixture('blender').html);
    let previous = confidenceFrom([]);
    for (let n = 1; n <= problems.length; n += 1) {
      const next = confidenceFrom(problems.slice(0, n));
      expect(next).toBeLessThanOrEqual(previous);
      previous = next;
    }
  });

  it('finds nothing to complain about on a clean page', () => {
    expect(costAmbiguities(loadFixture('kettle').html)).toEqual([]);
    expect(priceAmbiguities(loadFixture('kettle').html)).toEqual([]);
  });

  it('treats a missing cost as near-fatal', () => {
    expect(confidenceFrom(costAmbiguities('<div>no cost here</div>'))).toBeLessThan(0.1);
  });
});

describe('extraction feeding the gate — the §5.4 loop closed', () => {
  const merchantKey = generateKeyPair('merchant');
  const gateKey = generateKeyPair('gate');
  const mandate = issueMandate(
    draftMandate({ merchantId: 'acc_X', gateKey: publicKeyRef(gateKey), issuedAt: NOW }),
    merchantKey,
    NOW,
  );

  const { catalog } = extractCatalog('acc_X', [
    loadFixture('kettle', NOW),
    loadFixture('blender', NOW),
  ]);

  const pricing = new Map<string, SkuPricing>(
    catalog.entries.map((entry) => [entry.sku, pricingOf(entry)]),
  );

  function quote(sku: string, depthPct: number) {
    return evaluateQuote(
      {
        kind: 'quote',
        buyerId: 'buyer_a',
        lines: [{ sku, quantity: 1 }],
        requestedDepthPct: depthPct,
        rationale: 'test',
      },
      {
        mandate,
        gateKey,
        pricing,
        budget: openBudget(rupeesToPaise(40000), dayKeyOf(NOW)),
        pressure: INITIAL_PRESSURE,
        now: NOW,
        offerId: `off_${sku}`,
      },
    );
  }

  it('permits a discount on the confidently-extracted SKU', () => {
    expect(quote('SKU-KETTLE-1L', 10).ok).toBe(true);
  });

  /**
   * The whole mechanic, end to end: a messy page produced a low-confidence
   * cost, that confidence rode into the catalog on the field's own provenance,
   * and the gate refused a discount citing the confidence clause by name.
   * Uncertainty in the data layer propagated into the permission layer without
   * anyone wiring it there by hand.
   */
  it('refuses any discount on the SKU whose cost could not be trusted', () => {
    const decision = quote('SKU-BLENDER-500', 5);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.clause).toBe('confidence_policy.min_margin_confidence');
      expect(decision.refusal.reason).toContain('SKU-BLENDER-500');
    }
  });

  it('still sells that SKU at list price', () => {
    expect(quote('SKU-BLENDER-500', 0).ok).toBe(true);
  });
});

describe('extractCatalog', () => {
  it('builds a catalog from several pages', () => {
    const { catalog, reports } = extractCatalog('acc_X', [
      loadFixture('kettle', NOW),
      loadFixture('espresso', NOW),
      loadFixture('blender', NOW),
    ]);
    expect(catalog.entries).toHaveLength(3);
    expect(catalog.merchant_id).toBe('acc_X');
    expect(reports.size).toBe(3);
  });

  it('reads the espresso machine cleanly', () => {
    const result = extractEntry(loadFixture('espresso', NOW));
    expect(result.entry.list_price_inr.value).toBe(18990);
    expect(result.entry.unit_cost_inr.value).toBe(9100);
    expect(result.entry.unit_cost_inr.provenance.confidence).toBeGreaterThan(0.9);
  });
});
