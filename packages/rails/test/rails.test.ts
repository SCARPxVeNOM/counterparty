import { describe, expect, it, vi } from 'vitest';
import {
  draftMandate,
  evaluateQuote,
  generateKeyPair,
  issueMandate,
  openBudget,
  dayKeyOf,
  publicKeyRef,
  rupeesToPaise,
  INITIAL_PRESSURE,
  type QuoteProposal,
  type RefundAuthorization,
  type SignedOffer,
  type SkuPricing,
} from '@counterparty/core';
import { RazorpayClient } from '../src/client';
import { LiveAuthorizer, SimAuthorizer } from '../src/authorize';
import type { CheckoutHost, CheckoutRequest } from '../src/checkout';
import { Rails } from '../src/rails';
import { RailsError, type RazorpayPayment } from '../src/types';

const merchantKey = generateKeyPair('merchant');
const gateKey = generateKeyPair('gate');
const NOW = new Date('2026-08-25T09:00:00+05:30');

const mandate = issueMandate(
  draftMandate({ merchantId: 'acc_TEST0001', gateKey: publicKeyRef(gateKey), issuedAt: NOW, envelopeId: 'env_test' }),
  merchantKey,
  NOW,
);

const KETTLE: SkuPricing = {
  sku: 'SKU-KETTLE-1L',
  listPrice: rupeesToPaise(4990),
  unitCost: rupeesToPaise(3400),
  marginConfidence: 0.94,
  availability: 'in_stock',
  agentPurchasable: true,
  maxQuantityPerOrder: 5,
};

function signedOffer(depthPct = 10, extra: Partial<QuoteProposal> = {}): SignedOffer {
  const proposal: QuoteProposal = {
    kind: 'quote',
    buyerId: 'buyer_a',
    lines: [{ sku: 'SKU-KETTLE-1L', quantity: 1 }],
    requestedDepthPct: depthPct,
    rationale: 'closing today',
    ...extra,
  };
  const decision = evaluateQuote(proposal, {
    mandate,
    gateKey,
    pricing: new Map([[KETTLE.sku, KETTLE]]),
    budget: openBudget(rupeesToPaise(40000), dayKeyOf(NOW)),
    pressure: INITIAL_PRESSURE,
    now: NOW,
    offerId: 'off_test_0001',
  });
  if (!decision.ok) throw new Error(decision.refusal.reason);
  return decision.offer;
}

/** A fetch stub that records calls and replies from a route table. */
function stubFetch(routes: Record<string, unknown>, failing: string[] = []) {
  const calls: Array<{ path: string; body: any }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://api.razorpay.com/v1', '');
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ path, body });

    if (failing.includes(path)) {
      return new Response(JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: 'nope' } }), {
        status: 400,
      });
    }
    // Longest match wins, so `/orders` does not shadow `/orders/:id/payments`.
    const match = Object.keys(routes)
      .filter((route) => path.startsWith(route))
      .sort((a, b) => b.length - a.length)[0];
    if (match === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(routes[match]), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const ORDER = { id: 'order_ABC123', amount: 449100, currency: 'INR', status: 'created', receipt: 'off_test_0001' };
const CAPTURED = {
  id: 'pay_XYZ789',
  order_id: 'order_ABC123',
  amount: 449100,
  status: 'captured',
  method: 'card',
  captured: true,
  created_at: 1_787_000_000,
};

function railsWith(routes: Record<string, unknown>, failing: string[] = [], sim = true) {
  const { impl, calls } = stubFetch(routes, failing);
  const client = new RazorpayClient({
    credentials: { keyId: 'rzp_test_stub', keySecret: 'stubsecret' },
    fetchImpl: impl,
  });
  const authorizer = sim
    ? new SimAuthorizer({ now: () => NOW, idFor: () => 'pay_SIM0001' })
    : new LiveAuthorizer(client, { pollIntervalMs: 1, timeoutMs: 10, sleep: async () => {} });
  return { rails: new Rails({ client, authorizer, mandate }), calls };
}

describe('createOrder', () => {
  it('uses the price the gate signed, and holds the payment uncaptured', async () => {
    const { rails, calls } = railsWith({ '/orders': ORDER });
    const offer = signedOffer(10);
    const order = await rails.createOrder(offer);

    expect(order.id).toBe('order_ABC123');
    expect(calls[0]?.path).toBe('/orders');
    expect(calls[0]?.body.amount).toBe(rupeesToPaise(offer.offered_total_inr));
    // The decaying-option primitive: capture is a later, separate decision.
    expect(calls[0]?.body.payment_capture).toBe(0);
  });

  it('records the authorizing clause and envelope on the Razorpay object', async () => {
    const { rails, calls } = railsWith({ '/orders': ORDER });
    await rails.createOrder(signedOffer());
    expect(calls[0]?.body.notes.envelope_id).toBe('env_test');
    expect(calls[0]?.body.notes.authorized_by).toBe('authority.max_discount_depth_pct');
  });
});

describe('the runtime half of "unsigned is not binding"', () => {
  it('refuses an offer forced through a cast', async () => {
    const { rails, calls } = railsWith({ '/orders': ORDER });
    const forged = { ...signedOffer(), offered_total_inr: 1 } as unknown as SignedOffer;

    await expect(rails.createOrder(forged)).rejects.toThrow(RailsError);
    await expect(rails.createOrder(forged)).rejects.toThrow(/failed signature verification/);
    expect(calls).toHaveLength(0);
  });

  /**
   * A perfectly valid signature from a gate this envelope never delegated to.
   * The check is against `mandate.gate_key`, not against "any gate key".
   */
  it('refuses an offer signed by a gate the envelope did not name', async () => {
    const otherGate = generateKeyPair('gate');
    const otherMandate = issueMandate(
      draftMandate({ merchantId: 'acc_TEST0001', gateKey: publicKeyRef(otherGate), issuedAt: NOW }),
      merchantKey,
      NOW,
    );
    const decision = evaluateQuote(
      { kind: 'quote', buyerId: 'b', lines: [{ sku: 'SKU-KETTLE-1L', quantity: 1 }], requestedDepthPct: 5, rationale: 'x' },
      {
        mandate: otherMandate,
        gateKey: otherGate,
        pricing: new Map([[KETTLE.sku, KETTLE]]),
        budget: openBudget(rupeesToPaise(40000), dayKeyOf(NOW)),
        pressure: INITIAL_PRESSURE,
        now: NOW,
        offerId: 'off_other',
      },
    );
    if (!decision.ok) throw new Error('setup failed');

    const { rails } = railsWith({ '/orders': ORDER });
    await expect(rails.createOrder(decision.offer)).rejects.toThrow(/key_mismatch/);
  });
});

describe('capture', () => {
  it('sends the full authorized amount, because Razorpay requires it', async () => {
    const { rails, calls } = railsWith({ '/payments/': CAPTURED });
    const payment: RazorpayPayment = {
      id: 'pay_XYZ789',
      order_id: 'order_ABC123',
      amount_paise: 449100,
      status: 'authorized',
      method: 'card',
      captured: false,
      authorized_at: NOW.toISOString(),
      simulated: false,
    };

    await rails.captureFull(payment);
    expect(calls[0]?.path).toBe('/payments/pay_XYZ789/capture');
    expect(calls[0]?.body.amount).toBe(449100);
  });
});

describe('settlement — CORRECTIONS C1', () => {
  const authorized: RazorpayPayment = {
    id: 'pay_XYZ789',
    order_id: 'order_ABC123',
    amount_paise: 499000,
    status: 'authorized',
    method: 'card',
    captured: false,
    authorized_at: NOW.toISOString(),
    simulated: false,
  };

  it('Path A settles a pre-auth concession with a single full capture', async () => {
    const { rails, calls } = railsWith({ '/payments/': { ...CAPTURED, amount: 499000 } });
    const settlement = await rails.settle(signedOffer(), authorized);

    expect(settlement.path).toBe('pre_auth');
    expect(settlement.refund).toBeUndefined();
    expect(settlement.net_paise).toBe(499000);
    expect(settlement.rails).toEqual(['pay_XYZ789:capture']);
    expect(calls.filter((c) => c.path.includes('refund'))).toHaveLength(0);
  });

  /**
   * Path B: Razorpay will not capture less than the authorized amount, so a
   * post-authorization concession is composed from a full capture plus a refund
   * of the delta. One gate decision, two rails calls, one net.
   */
  it('Path B composes a full capture with a refund of the delta', async () => {
    const { rails, calls } = railsWith({
      '/payments/pay_XYZ789/capture': { ...CAPTURED, amount: 499000 },
      '/payments/pay_XYZ789/refund': { id: 'rfnd_QQQ', payment_id: 'pay_XYZ789', amount: 74850 },
    });

    const offer = signedOffer(10, { settlementPath: 'post_auth', postAuthReason: 'partial_fulfilment' });
    const authorization: RefundAuthorization = {
      payment_id: 'pay_XYZ789',
      refund_amount_inr: 748.5,
      is_partial: true,
      authorized_by: 'authority.max_discount_depth_pct',
      requires_human: false,
    };

    const settlement = await rails.settle(offer, authorized, { authorization });

    expect(settlement.path).toBe('post_auth');
    expect(settlement.net_paise).toBe(499000 - 74850);
    expect(settlement.rails).toEqual(['pay_XYZ789:capture', 'rfnd_QQQ:refund']);
    expect(calls.map((c) => c.path)).toEqual([
      '/payments/pay_XYZ789/capture',
      '/payments/pay_XYZ789/refund',
    ]);
  });

  /**
   * The dangerous half-state. The capture cannot be rolled back — it is exactly
   * the state the buyer is owed a refund from — so the error has to carry both
   * amounts and the payment id, or the money is stranded with nothing pointing
   * at it.
   */
  it('names the payment and the amount owed when the refund leg fails', async () => {
    const { rails } = railsWith(
      { '/payments/pay_XYZ789/capture': { ...CAPTURED, amount: 499000 } },
      ['/payments/pay_XYZ789/refund'],
    );

    const offer = signedOffer(10, { settlementPath: 'post_auth', postAuthReason: 'out_of_stock' });
    const authorization: RefundAuthorization = {
      payment_id: 'pay_XYZ789',
      refund_amount_inr: 748.5,
      is_partial: true,
      authorized_by: 'authority.max_discount_depth_pct',
      requires_human: false,
    };

    await expect(rails.settle(offer, authorized, { authorization })).rejects.toThrow(
      /pay_XYZ789.*748\.5.*settled by hand/s,
    );
  });

  /**
   * Fell out of writing the two tests above: hand-editing `settlement_path` on
   * a signed offer to force the post-auth route invalidates the signature, so
   * the rails refuse it. The choice of settlement path is part of what the gate
   * signed — it cannot be changed downstream by whoever executes the offer.
   */
  it('refuses a settlement path edited after signing', async () => {
    const { rails } = railsWith({ '/payments/': CAPTURED });
    const forced = { ...signedOffer(), settlement_path: 'post_auth' } as unknown as SignedOffer;

    await expect(
      rails.settle(forced, authorized, {
        authorization: {
          payment_id: 'pay_XYZ789',
          refund_amount_inr: 100,
          is_partial: true,
          authorized_by: 'authority.refund_authority.partial',
          requires_human: false,
        },
      }),
    ).rejects.toThrow(/failed signature verification/);
  });

  it('records a deliberate lapse without calling Razorpay at all', async () => {
    const { rails, calls } = railsWith({});
    const settlement = rails.lapse(signedOffer(), authorized, 'stock check failed');

    expect(settlement.net_paise).toBe(0);
    expect(settlement.rails[0]).toContain('lapsed(stock check failed)');
    expect(calls).toHaveLength(0);
  });
});

describe('refunds', () => {
  it('refuses to execute one that needs a human', async () => {
    const { rails, calls } = railsWith({ '/payments/': { id: 'rfnd_X', payment_id: 'p', amount: 1 } });
    const payment: RazorpayPayment = {
      id: 'pay_XYZ789',
      order_id: 'o',
      amount_paise: 2_000_000,
      status: 'captured',
      method: 'card',
      captured: true,
      authorized_at: NOW.toISOString(),
      simulated: false,
    };

    await expect(
      rails.refund(payment, {
        payment_id: 'pay_XYZ789',
        refund_amount_inr: 8000,
        is_partial: true,
        authorized_by: 'authority.refund_authority.requires_human_above_inr',
        requires_human: true,
      }),
    ).rejects.toThrow(/needs human approval/);
    expect(calls).toHaveLength(0);
  });
});

describe('the simulated cardholder', () => {
  it('marks the payment simulated, and the flag survives capture', async () => {
    const { rails, calls } = railsWith({ '/orders': ORDER });
    const offer = signedOffer();
    const order = await rails.createOrder(offer);
    const payment = await rails.authorize(order, offer);

    expect(payment.simulated).toBe(true);
    expect(payment.id).toMatch(/^pay_SIM/);

    const settlement = await rails.settle(offer, payment);
    expect(settlement.simulated).toBe(true);
    // The order was real; nothing downstream of the fake tap touched Razorpay.
    expect(calls.map((c) => c.path)).toEqual(['/orders']);
  });

  /**
   * A simulated object that looks like a real one is a trap for whoever reads
   * the logs later.
   */
  it('uses a visibly distinct id prefix', async () => {
    const { rails } = railsWith({ '/orders': ORDER });
    const offer = signedOffer();
    const payment = await rails.authorize(await rails.createOrder(offer), offer);
    expect(payment.id.startsWith('pay_SIM')).toBe(true);
  });

  it('can simulate a cardholder who abandons the payment', async () => {
    const { impl } = stubFetch({ '/orders': ORDER });
    const client = new RazorpayClient({
      credentials: { keyId: 'rzp_test_stub', keySecret: 's' },
      fetchImpl: impl,
    });
    const rails = new Rails({
      client,
      authorizer: new SimAuthorizer({ failWith: 'failed' }),
      mandate,
    });
    const offer = signedOffer();
    await expect(rails.authorize(await rails.createOrder(offer), offer)).rejects.toThrow(/abandoned/);
  });
});

describe('the live authorizer', () => {
  /**
   * A checkout host that binds no port, and records what it was asked to show.
   *
   * The tests these replaced stubbed `fetch`, asserted that `/payment_links`
   * was called, and passed — while the route they described could not work at
   * all, because a payment link carries its own order and the poll watches
   * ours. A stub will answer a request reality never routes. So the assertion
   * that matters now is which order the human is actually paying.
   */
  function fakeCheckout() {
    const shown: CheckoutRequest[] = [];
    let closed = 0;
    const host: CheckoutHost = {
      open: async (request) => {
        shown.push(request);
        return { url: 'http://127.0.0.1:9999/', close: async () => void closed++ };
      },
    };
    return { host, shown, closed: () => closed };
  }

  it('opens checkout bound to the order the gate signed, and returns the payment', async () => {
    const { impl, calls } = stubFetch({
      '/orders': ORDER,
      '/orders/order_ABC123/payments': { count: 1, items: [{ ...CAPTURED, status: 'authorized', captured: false }] },
    });
    const client = new RazorpayClient({ credentials: { keyId: 'rzp_test_s', keySecret: 's' }, fetchImpl: impl });
    const checkout = fakeCheckout();
    const rails = new Rails({
      client,
      authorizer: new LiveAuthorizer(client, {
        pollIntervalMs: 1,
        timeoutMs: 50,
        sleep: async () => {},
        checkout: checkout.host,
      }),
      mandate,
    });

    const offer = signedOffer();
    const order = await rails.createOrder(offer);
    const payment = await rails.authorize(order, offer);

    expect(payment.simulated).toBe(false);
    expect(payment.id).toBe('pay_XYZ789');

    // The binding this whole class exists for.
    expect(checkout.shown).toHaveLength(1);
    expect(checkout.shown[0]?.orderId).toBe(order.id);
    expect(checkout.shown[0]?.amountPaise).toBe(order.amount_paise);

    // And it must NOT reach for a payment link, which would take the money
    // onto an order this poll can never see.
    expect(calls.some((c) => c.path === '/payment_links')).toBe(false);
  });

  it('publishes the key id but never the secret', async () => {
    const { impl } = stubFetch({
      '/orders': ORDER,
      '/orders/order_ABC123/payments': { count: 1, items: [{ ...CAPTURED, status: 'authorized', captured: false }] },
    });
    const client = new RazorpayClient({
      credentials: { keyId: 'rzp_test_s', keySecret: 'topsecret' },
      fetchImpl: impl,
    });
    const checkout = fakeCheckout();
    const rails = new Rails({
      client,
      authorizer: new LiveAuthorizer(client, {
        pollIntervalMs: 1,
        timeoutMs: 50,
        sleep: async () => {},
        checkout: checkout.host,
      }),
      mandate,
    });

    const offer = signedOffer();
    await rails.authorize(await rails.createOrder(offer), offer);

    expect(checkout.shown[0]?.keyId).toBe('rzp_test_s');
    expect(JSON.stringify(checkout.shown)).not.toContain('topsecret');
  });

  it('times out naming the checkout url, and closes the page either way', async () => {
    let elapsed = 0;
    const { impl } = stubFetch({
      '/orders': ORDER,
      '/orders/order_ABC123/payments': { count: 0, items: [] },
    });
    const client = new RazorpayClient({ credentials: { keyId: 'rzp_test_s', keySecret: 's' }, fetchImpl: impl });
    const checkout = fakeCheckout();
    const rails = new Rails({
      client,
      authorizer: new LiveAuthorizer(client, {
        pollIntervalMs: 1,
        timeoutMs: 10,
        now: () => (elapsed += 6),
        sleep: async () => {},
        checkout: checkout.host,
      }),
      mandate,
    });

    const offer = signedOffer();
    await expect(rails.authorize(await rails.createOrder(offer), offer)).rejects.toThrow(
      /127\.0\.0\.1:9999/,
    );
    expect(checkout.closed()).toBe(1);
  });
});

describe('campaigns', () => {
  /**
   * Razorpay has no create-offer API — POST /offers returns 405 and the docs
   * are explicit that offers are Dashboard-only (CORRECTIONS C6). So a campaign
   * executes as a payment link at the price the gate signed, and any Razorpay
   * offer it carries is one the merchant already authorized by hand.
   */
  it('executes as a payment link at the gate-signed price', async () => {
    const { rails, calls } = railsWith({
      '/payment_links': { id: 'plink_c1', short_url: 'https://rzp.io/i/camp', amount: 449100, status: 'created' },
    });
    const signed = signedOffer(10);
    const link = await rails.createCampaignLink(signed);

    expect(link.id).toBe('plink_c1');
    expect(calls[0]?.body.amount).toBe(rupeesToPaise(signed.offered_total_inr));
    expect(calls[0]?.body.notes.campaign).toBe('true');
    expect(calls[0]?.body.notes.authorized_by).toBe(signed.authorized_by);
  });

  it('attaches a Dashboard-created offer when the merchant has one', async () => {
    const { rails, calls } = railsWith({
      '/payment_links': { id: 'plink_c2', short_url: 'https://rzp.io/i/camp2', amount: 449100, status: 'created' },
    });
    await rails.createCampaignLink(signedOffer(10), 'offer_DASHBOARD1');
    expect(calls[0]?.body.offer_id).toBe('offer_DASHBOARD1');
  });

  it('refuses an unsigned campaign offer just like a negotiated one', async () => {
    const { rails, calls } = railsWith({ '/payment_links': {} });
    const forged = { ...signedOffer(), offered_total_inr: 1 } as unknown as SignedOffer;
    await expect(rails.createCampaignLink(forged)).rejects.toThrow(/failed signature verification/);
    expect(calls).toHaveLength(0);
  });

  it('reads offers the merchant already created', async () => {
    const { rails } = railsWith({ '/offers': { items: [{ id: 'offer_1', name: 'Win-back', value: 1200 }] } });
    const offers = await rails.listOffers();
    expect(offers).toEqual([{ id: 'offer_1', name: 'Win-back', value_pct: 12, simulated: false }]);
  });

  it('reports subscriptions as unavailable when the product is switched off', async () => {
    const { rails } = railsWith({}, ['/plans?count=1']);
    expect(await rails.subscriptionsAvailable()).toBe(false);
  });
});

describe('client', () => {
  it('surfaces Razorpay error codes intact', async () => {
    const { impl } = stubFetch({}, ['/orders']);
    const client = new RazorpayClient({ credentials: { keyId: 'k', keySecret: 's' }, fetchImpl: impl });
    await expect(client.post('/orders', {})).rejects.toMatchObject({ code: 'BAD_REQUEST_ERROR', status: 400 });
  });

  it('refuses to construct without credentials', () => {
    expect(() => new RazorpayClient({ credentials: { keyId: '', keySecret: '' } })).toThrow(/credentials are missing/);
  });

  it('recognises a test key', () => {
    expect(RazorpayClient.isTestKey('rzp_test_abc')).toBe(true);
    expect(RazorpayClient.isTestKey('rzp_live_abc')).toBe(false);
  });
});
