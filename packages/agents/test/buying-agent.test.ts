/**
 * The autonomous buyer.
 *
 * Every merchant here is a fake endpoint returning JSON, which is the same thing
 * the real adapter does — the buyer cannot tell the difference, and that is the
 * property being tested. If any of these needed a `Session` to pass, the buyer
 * would be reaching across a boundary it claims not to.
 *
 * The load-bearing tests are the ones asserting `pay` was never CALLED. An agent
 * that reports a problem and pays anyway has done nothing; the number that
 * matters is how many times money moved.
 */

import { describe, expect, it } from 'vitest';
import {
  generateKeyPair,
  publicKeyRef,
  signPayload,
  publishCatalog,
  rupeesToPaise,
  type JsonObject,
  type SkuPricing,
} from '@counterparty/core';
import type { GenerateRequest, GenerateResult, LLMProvider } from '@counterparty/llm';
import {
  BuyingAgent,
  type BuyerMandate,
  type MerchantEndpoint,
  type PaymentReceipt,
} from '../src/buying-agent';

const merchantKey = generateKeyPair('merchant');
const gateKey = generateKeyPair('gate');
const NOW = new Date('2026-09-04T10:00:00Z');

const KETTLE: SkuPricing = {
  sku: 'SKU-KETTLE-1L',
  listPrice: rupeesToPaise(4990),
  unitCost: rupeesToPaise(3400),
  marginConfidence: 0.94,
  availability: 'in_stock',
  agentPurchasable: true,
  maxQuantityPerOrder: 5,
};

const GIFT_CARD: SkuPricing = { ...KETTLE, sku: 'SKU-KETTLE-CARD', agentPurchasable: false };

/** A silent provider. These tests never need the buyer to improvise. */
const mute: LLMProvider = {
  name: 'mute',
  generate: async (_request: GenerateRequest): Promise<GenerateResult> => ({
    text: '',
    model: 'mute',
    fromCassette: false,
  }),
};

function envelope(overrides: Record<string, unknown> = {}): JsonObject {
  const body = {
    version: 'counterparty/selling-mandate/1',
    envelope_id: 'env_test',
    merchant_id: 'acc_TEST0001',
    issued_at: '2026-09-01T00:00:00Z',
    expires_at: '2026-10-01T00:00:00Z',
    gate_key: { kid: gateKey.kid, public_key_pem: gateKey.publicKeyPem },
    authority: {
      floor_margin_pct: 18,
      max_discount_depth_pct: 15,
      eligible_skus: ['SKU-*'],
      excluded_skus: ['SKU-CLEARANCE-*'],
      bundle_rules: { max_items: 3, combined_depth_pct: 20 },
      refund_authority: { partial: true, full_above_inr: 0, requires_human_above_inr: 5000 },
      capture_window_hours: 72,
      discount_budget_inr_per_day: 40000,
      per_buyer_discount_cap_inr: 2000,
    },
    confidence_policy: { min_margin_confidence: 0.85, below_threshold_discount_depth_pct: 0 },
    pressure_policy: { collapse_threshold: 0.7, guard_threshold: 0.35, on_collapse: ['depth_pct=0'] },
    ...overrides,
  };
  return JSON.parse(JSON.stringify(signPayload(body as JsonObject, merchantKey, NOW))) as JsonObject;
}

function offer(
  overrides: Record<string, unknown> = {},
  key = gateKey,
): JsonObject {
  const body = {
    version: 'counterparty/signed-offer/1',
    offer_id: 'off_1',
    envelope_id: 'env_test',
    merchant_id: 'acc_TEST0001',
    buyer_id: 'buyer_autonomous',
    currency: 'INR',
    lines: [
      { sku: 'SKU-KETTLE-1L', quantity: 2, list_unit_price_inr: 4990, offered_unit_price_inr: 4690.6 },
    ],
    list_total_inr: 9980,
    offered_total_inr: 9381.2,
    depth_pct: 6,
    issued_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 900_000).toISOString(),
    settlement_path: 'pre_auth',
    authorized_by: 'authority.max_discount_depth_pct',
    reservation_id: 'rsv_1',
    pressure_score: 0,
    ...overrides,
  };
  return JSON.parse(JSON.stringify(signPayload(body as JsonObject, key, NOW))) as JsonObject;
}

interface FakeMerchant extends MerchantEndpoint {
  readonly payCalls: string[];
}

function merchant(options: {
  offer?: JsonObject | undefined;
  envelope?: JsonObject;
  pricing?: SkuPricing[];
}): FakeMerchant {
  const payCalls: string[] = [];
  return {
    payCalls,
    catalog: async () =>
      publishCatalog(options.pricing ?? [KETTLE], {
        merchantId: 'acc_TEST0001',
        envelopeId: 'env_test',
        publishedAt: NOW,
      }),
    envelope: async () => options.envelope ?? envelope(),
    say: async () => ({
      reply: 'Two kettles come to ₹9,381.20.',
      ...(options.offer === undefined ? {} : { offer: options.offer }),
    }),
    pay: async (offerId: string): Promise<PaymentReceipt> => {
      payCalls.push(offerId);
      return {
        orderId: 'order_TEST',
        paymentId: 'pay_TEST',
        amountInr: 9381.2,
        status: 'captured',
        simulated: true,
      };
    },
  };
}

const MANDATE: BuyerMandate = {
  buyerId: 'buyer_autonomous',
  wants: 'kettle',
  quantity: 2,
  maxUnitPriceInr: 6000,
  maxTotalInr: 9600,
  protocols: ['ap2', 'upi-uap'],
};

function agent(m: MerchantEndpoint, mandate: BuyerMandate = MANDATE): BuyingAgent {
  return new BuyingAgent({
    mandate,
    merchant: m,
    merchantPublicKey: publicKeyRef(merchantKey),
    provider: mute,
    model: 'mute',
    maxTurns: 1,
    now: () => NOW,
  });
}

describe('a purchase that should go through', () => {
  it('completes with nobody typing', async () => {
    const m = merchant({ offer: offer() });
    const run = await agent(m).run();
    expect(run.outcome.kind).toBe('purchased');
  });

  it('pays exactly once', async () => {
    const m = merchant({ offer: offer() });
    await agent(m).run();
    expect(m.payCalls).toEqual(['off_1']);
  });

  it('walks the whole path: discover, select, fetch, ask, verify, accept, pay', async () => {
    const m = merchant({ offer: offer() });
    const run = await agent(m).run();
    expect(run.steps.map((s) => s.kind)).toEqual([
      'discovered',
      'selected',
      'fetched_envelope',
      'asked',
      'received_offer',
      'verified',
      'accepted',
      'paid',
    ]);
  });

  it('pays the signed amount, not the list price', async () => {
    const run = await agent(merchant({ offer: offer() })).run();
    expect(run.outcome.kind === 'purchased' && run.outcome.paidInr).toBe(9381.2);
  });
});

/**
 * The reason this agent exists. Each of these offers is signed, and the buyer
 * does not pay for any of them.
 */
describe('offers the buyer refuses', () => {
  it('refuses a gate the merchant never delegated to, and does not pay', async () => {
    const rogue = generateKeyPair('gate');
    const m = merchant({ offer: offer({ offer_id: 'off_rogue', depth_pct: 6 }, rogue) });
    const run = await agent(m).run();

    expect(run.outcome.kind).toBe('refused');
    expect(run.outcome.kind === 'refused' && run.outcome.failedCheck).toBe('gate_is_delegated');
    expect(m.payCalls).toEqual([]);
  });

  it('refuses an offer edited after signing, and does not pay', async () => {
    const edited = { ...offer(), offered_total_inr: 8000 };
    const m = merchant({ offer: edited });
    const run = await agent(m).run();

    expect(run.outcome.kind === 'refused' && run.outcome.failedCheck).toBe('offer_signature');
    expect(m.payCalls).toEqual([]);
  });

  it('refuses a depth beyond the published ceiling, and does not pay', async () => {
    const m = merchant({
      offer: offer({
        offer_id: 'off_deep',
        lines: [
          { sku: 'SKU-KETTLE-1L', quantity: 2, list_unit_price_inr: 4990, offered_unit_price_inr: 1996 },
        ],
        offered_total_inr: 3992,
        depth_pct: 60,
      }),
    });
    const run = await agent(m).run();

    expect(run.outcome.kind === 'refused' && run.outcome.failedCheck).toBe('within_published_authority');
    expect(m.payCalls).toEqual([]);
  });

  it('refuses when the envelope itself was not signed by the merchant', async () => {
    const impostor = generateKeyPair('merchant');
    const forged = JSON.parse(
      JSON.stringify(
        signPayload(
          JSON.parse(JSON.stringify({ ...envelope(), signature: undefined })) as JsonObject,
          impostor,
          NOW,
        ),
      ),
    ) as JsonObject;

    const m = merchant({ offer: offer(), envelope: forged });
    const run = await agent(m).run();

    expect(run.outcome.kind === 'refused' && run.outcome.failedCheck).toBe('envelope_signature');
    expect(m.payCalls).toEqual([]);
  });

  /**
   * A merchant who widens its own published ceiling to justify a deeper
   * discount. The envelope no longer verifies, so the discount is unauthorized
   * even though the offer that cites it is perfectly signed.
   */
  it('refuses when the envelope was widened to permit the discount', async () => {
    const widened = { ...envelope() };
    (widened['authority'] as Record<string, unknown>)['max_discount_depth_pct'] = 90;

    const m = merchant({ offer: offer(), envelope: widened });
    const run = await agent(m).run();

    expect(run.outcome.kind === 'refused' && run.outcome.failedCheck).toBe('envelope_signature');
    expect(m.payCalls).toEqual([]);
  });
});

describe('the buyer’s own authority', () => {
  it('does not pay for a valid offer it cannot afford', async () => {
    const m = merchant({ offer: offer() });
    const poor = await agent(m, { ...MANDATE, maxTotalInr: 5000 }).run();

    expect(poor.outcome.kind).toBe('no_deal');
    expect(m.payCalls).toEqual([]);
    expect(poor.steps.some((s) => s.kind === 'over_budget')).toBe(true);
  });

  it('treats over-budget as a price problem, not a trust problem', async () => {
    // The offer was genuine. Recording it as a refusal would say the merchant
    // did something wrong, and the merchant did not.
    const run = await agent(merchant({ offer: offer() }), { ...MANDATE, maxTotalInr: 5000 }).run();
    expect(run.verdicts.every((v) => v.accepted)).toBe(true);
    expect(run.steps.some((s) => s.kind === 'rejected_offer')).toBe(false);
  });

  it('will not consider a SKU above its unit-price ceiling', async () => {
    const run = await agent(merchant({ offer: offer() }), {
      ...MANDATE,
      maxUnitPriceInr: 1000,
    }).run();
    expect(run.outcome.kind).toBe('no_deal');
    expect(run.steps.some((s) => s.kind === 'nothing_suitable')).toBe(true);
  });

  it('will not consider a SKU the merchant marked not agent-purchasable', async () => {
    const run = await agent(merchant({ offer: offer(), pricing: [GIFT_CARD] })).run();
    expect(run.steps.some((s) => s.kind === 'nothing_suitable')).toBe(true);
  });

  it('will not consider a merchant speaking no protocol it shares', async () => {
    const run = await agent(merchant({ offer: offer() }), {
      ...MANDATE,
      protocols: ['x402'],
    }).run();
    expect(run.outcome.kind).toBe('no_deal');
  });
});

describe('a negotiation that produces nothing', () => {
  it('ends without paying when no offer is ever made', async () => {
    const m = merchant({ offer: undefined });
    const run = await agent(m).run();

    expect(run.outcome.kind).toBe('no_deal');
    expect(m.payCalls).toEqual([]);
    expect(run.steps.at(-1)?.kind).toBe('gave_up');
  });
});

describe('what the buyer is allowed to see', () => {
  it('never receives a unit cost', async () => {
    const m = merchant({ offer: offer() });
    const serialized = JSON.stringify(await m.catalog());
    expect(serialized).not.toContain('3400');
    expect(serialized).not.toContain(String(rupeesToPaise(3400)));
  });
});
