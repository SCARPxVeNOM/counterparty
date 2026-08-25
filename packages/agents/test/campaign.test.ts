import { describe, expect, it } from 'vitest';
import {
  dayKeyOf,
  draftMandate,
  generateKeyPair,
  issueMandate,
  openBudget,
  publicKeyRef,
  rupeesToPaise,
  verifyChain,
  verifySigned,
  available,
  commit,
  reserve,
  type JsonObject,
  type SkuPricing,
} from '@counterparty/core';
import { campaignCostInr, isSynthetic, runCampaign, type Segment } from '../src/campaign';

const merchantKey = generateKeyPair('merchant');
const gateKey = generateKeyPair('gate');
const NOW = new Date('2026-08-25T09:00:00+05:30');

const mandate = issueMandate(
  draftMandate({ merchantId: 'acc_C', gateKey: publicKeyRef(gateKey), issuedAt: NOW, envelopeId: 'env_c' }),
  merchantKey,
  NOW,
);

/** Fat margin so the floor does not bind before the budget does. */
const ESPRESSO: SkuPricing = {
  sku: 'SKU-ESPRESSO-PRO',
  listPrice: rupeesToPaise(18990),
  unitCost: rupeesToPaise(9100),
  marginConfidence: 0.91,
  availability: 'in_stock',
  agentPurchasable: true,
  maxQuantityPerOrder: 3,
};

const catalog = new Map([[ESPRESSO.sku, ESPRESSO]]);

function segment(count: number, source: Segment['source'] = 'synthetic'): Segment {
  return {
    id: 'seg_test',
    name: 'Halted subscribers — win-back',
    source,
    members: Array.from({ length: count }, (_, i) => ({
      buyerId: `sub_hlt_${String(i + 1).padStart(4, '0')}`,
      label: `halted after 4 failed charges`,
      sku: ESPRESSO.sku,
      quantity: 1,
    })),
  };
}

function run(count: number, depthPct = 10, budgetInr = 40000, source: Segment['source'] = 'synthetic') {
  return runCampaign({
    campaignId: 'camp_test',
    mandate,
    gateKey,
    catalog,
    budget: openBudget(rupeesToPaise(budgetInr), dayKeyOf(NOW)),
    segment: segment(count, source),
    depthPct,
    rationale: 'win-back offer to lapsed subscribers',
    now: NOW,
  });
}

describe('a campaign that fits inside the budget', () => {
  // 10% of ₹18,990 is ₹1,899 per member. Three fit inside ₹40,000.
  const result = run(3);

  it('reaches every member', () => {
    expect(result.reached).toBe(3);
    expect(result.refused).toBe(0);
    expect(result.stoppedEarly).toBe(false);
  });

  it('signs a real offer for each one', () => {
    for (const outcome of result.outcomes) {
      expect(outcome.offer).toBeDefined();
      expect(verifySigned(outcome.offer as unknown as JsonObject, publicKeyRef(gateKey)).ok).toBe(true);
    }
  });

  it('draws the whole cost from the shared pool', () => {
    expect(result.committedInr).toBeCloseTo(1899 * 3, 0);
    expect(available(result.budget, NOW)).toBe(rupeesToPaise(40000 - 1899 * 3));
  });

  it('writes one hash-chained row per member', () => {
    expect(result.ledger.rows).toHaveLength(3);
    expect(result.ledger.rows.every((r) => r.action === 'campaign_offer_issued')).toBe(true);
    expect(verifyChain(result.ledger.rows).ok).toBe(true);
  });

  it('addresses each member individually rather than in bulk', () => {
    const buyers = result.ledger.rows.map((r) => r.buyer_id);
    expect(new Set(buyers).size).toBe(3);
  });
});

describe('a campaign that outruns its budget', () => {
  /**
   * The behaviour worth demonstrating. Twelve members at ₹1,899 each is
   * ₹22,788, which fits — so squeeze the pool instead and watch the campaign
   * stop itself partway.
   */
  const result = run(12, 10, 8000);

  it('stops when the pool empties', () => {
    expect(result.reached).toBe(4); // 4 x ₹1,899 = ₹7,596, the 5th does not fit
    expect(result.refused).toBe(8);
    expect(result.stoppedEarly).toBe(true);
  });

  it('never spends past its authority', () => {
    expect(result.committedInr).toBeLessThanOrEqual(8000);
    expect(available(result.budget, NOW)).toBeGreaterThanOrEqual(0);
  });

  /**
   * The boundary is a row in the ledger, not a log line. A campaign that
   * silently truncated would be indistinguishable from one that was never
   * asked to reach the rest.
   */
  it('records a refusal for every member it could not reach', () => {
    const refusals = result.ledger.rows.filter((r) => r.outcome === 'refused');
    expect(refusals).toHaveLength(8);
    expect(refusals.every((r) => r.authorized_by === 'authority.discount_budget_inr_per_day')).toBe(true);
  });

  it('keeps the whole trail verifiable across both outcomes', () => {
    expect(result.ledger.rows).toHaveLength(12);
    expect(verifyChain(result.ledger.rows).ok).toBe(true);
  });
});

describe('the synthetic tag', () => {
  it('marks every row when the segment is invented', () => {
    const result = run(2);
    expect(result.synthetic).toBe(true);
    expect(result.ledger.rows.every((r) => r.agent_rationale.startsWith('[SYNTHETIC SEGMENT]'))).toBe(true);
  });

  /**
   * A made-up audience is a legitimate thing to demo and an illegitimate thing
   * to present as real. The difference has to survive into the artifact.
   */
  it('leaves rows unmarked when the segment is real', () => {
    const result = run(2, 10, 40000, 'razorpay_subscriptions');
    expect(result.synthetic).toBe(false);
    expect(result.ledger.rows.some((r) => r.agent_rationale.includes('SYNTHETIC'))).toBe(false);
  });

  it('is decided by the segment, not by the caller', () => {
    expect(isSynthetic(segment(1, 'synthetic'))).toBe(true);
    expect(isSynthetic(segment(1, 'razorpay_subscriptions'))).toBe(false);
    expect(isSynthetic(segment(1, 'razorpay_lapsed_authorizations'))).toBe(false);
  });
});

describe('the campaign runs through the same gate as a negotiation', () => {
  /**
   * The ₹2,000 per-buyer cap is 10.5% of an ₹18,990 item, so it binds before
   * the 15% depth ceiling on this SKU. Raised here to isolate the clause under
   * test; the cap's own behaviour is asserted immediately below.
   */
  it('is bound by the mandate depth ceiling', () => {
    const roomyCap = issueMandate(
      draftMandate({
        merchantId: 'acc_C',
        gateKey: publicKeyRef(gateKey),
        issuedAt: NOW,
        envelopeId: 'env_c',
        authority: { per_buyer_discount_cap_inr: 10000 },
      }),
      merchantKey,
      NOW,
    );
    const result = runCampaign({
      campaignId: 'camp_deep',
      mandate: roomyCap,
      gateKey,
      catalog,
      budget: openBudget(rupeesToPaise(40000), dayKeyOf(NOW)),
      segment: segment(2),
      depthPct: 40,
      rationale: 'r',
      now: NOW,
    });
    expect(result.reached).toBe(0);
    expect(result.refused).toBe(2);
    expect(result.ledger.rows[0]?.authorized_by).toBe('authority.max_discount_depth_pct');
  });

  it('is bound by the per-buyer cap like anyone else', () => {
    // ₹2,000 cap; 15% of ₹18,990 is ₹2,848.50.
    const result = run(1, 15);
    expect(result.refused).toBe(1);
    expect(result.ledger.rows[0]?.authorized_by).toBe('authority.per_buyer_discount_cap_inr');
  });

  it('refuses a SKU the envelope excludes', () => {
    const excluded: Segment = {
      ...segment(1),
      members: [{ buyerId: 'b', label: 'x', sku: 'SKU-CLEARANCE-X', quantity: 1 }],
    };
    const result = runCampaign({
      campaignId: 'c',
      mandate,
      gateKey,
      catalog: new Map([...catalog, ['SKU-CLEARANCE-X', { ...ESPRESSO, sku: 'SKU-CLEARANCE-X' }]]),
      budget: openBudget(rupeesToPaise(40000), dayKeyOf(NOW)),
      segment: excluded,
      depthPct: 5,
      rationale: 'r',
      now: NOW,
    });
    expect(result.ledger.rows[0]?.authorized_by).toBe('authority.excluded_skus');
  });
});

describe('the coupling in §7', () => {
  /**
   * One authority object, not a config file with two copies. A campaign spends
   * from the same pool a negotiation concedes from, so the morning's win-back
   * genuinely constrains the afternoon.
   */
  it('leaves a negotiation less room after it runs', () => {
    const campaign = run(12, 10, 40000);
    expect(campaign.reached).toBe(12);

    const before = 40000;
    const after = Number((available(campaign.budget, NOW) / 100).toFixed(2));

    expect(after).toBeLessThan(before);
    expect(before - after).toBeCloseTo(campaign.committedInr, 0);
  });

  it('is constrained by a negotiation that ran first', () => {
    const held = reserve(
      openBudget(rupeesToPaise(40000), dayKeyOf(NOW)),
      { id: 'nego_1', amount: rupeesToPaise(36000), buyerId: 'buyer_a', purpose: 'negotiation', ttlMs: 900_000 },
      NOW,
    );
    if (!held.ok) throw new Error('setup failed');
    const spent = commit(held.state, 'nego_1', NOW);
    if (!spent.ok) throw new Error('setup failed');

    const result = runCampaign({
      campaignId: 'camp_after',
      mandate,
      gateKey,
      catalog,
      budget: spent.state,
      segment: segment(12),
      depthPct: 10,
      rationale: 'win-back',
      now: NOW,
    });

    // ₹4,000 left, ₹1,899 each — only two fit.
    expect(result.reached).toBe(2);
    expect(result.refused).toBe(10);
  });
});

describe('campaignCostInr', () => {
  it('prices a campaign before it runs', () => {
    expect(campaignCostInr(segment(3), catalog, 10)).toBeCloseTo(5697, 0);
  });

  it('ignores members whose SKU is not in the catalog', () => {
    const unknown: Segment = { ...segment(1), members: [{ buyerId: 'b', label: 'x', sku: 'SKU-GHOST', quantity: 1 }] };
    expect(campaignCostInr(unknown, catalog, 10)).toBe(0);
  });
});
