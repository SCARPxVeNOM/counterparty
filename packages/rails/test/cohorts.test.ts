/**
 * Reading a win-back cohort out of a Razorpay account.
 *
 * The tests that matter are the exclusions. A cohort builder that is merely
 * generous produces a campaign aimed at people who already paid, spending real
 * budget on customers who need nothing — and every one of those is a row in an
 * audit trail claiming the merchant authorized a discount for a completed sale.
 */

import { describe, expect, it } from 'vitest';
import { RazorpayClient } from '../src/client';
import { haltedSubscriptionCohort, lapsedAuthorizationCohort } from '../src/cohorts';

const EPOCH = Math.floor(Date.parse('2026-08-26T00:00:00Z') / 1000);

interface Fixture {
  orders?: unknown[];
  payments?: unknown[];
  subscriptions?: unknown[];
}

/** A client whose network is a lookup table. */
function clientFor(fixture: Fixture): RazorpayClient {
  return new RazorpayClient({
    credentials: { keyId: 'rzp_test_x', keySecret: 'secret' },
    fetchImpl: (async (url: string) => {
      const path = String(url);
      const body = path.includes('/orders')
        ? { count: fixture.orders?.length ?? 0, items: fixture.orders ?? [] }
        : path.includes('/payments')
          ? { count: fixture.payments?.length ?? 0, items: fixture.payments ?? [] }
          : { count: fixture.subscriptions?.length ?? 0, items: fixture.subscriptions ?? [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });
}

const order = (id: string, amount: number, status = 'created', attempts = 0) => ({
  id,
  amount,
  status,
  attempts,
  created_at: EPOCH,
});

const payment = (id: string, orderId: string | null, status: string, amount = 499000) => ({
  id,
  order_id: orderId,
  status,
  amount,
  created_at: EPOCH,
  error_description: status === 'failed' ? 'card declined' : null,
});

const OPTIONS = { sku: 'SKU-KETTLE-1L', quantity: 1 };

describe('who belongs in a lapsed-authorization cohort', () => {
  it('includes an order created and never paid', async () => {
    const cohort = await lapsedAuthorizationCohort(
      clientFor({ orders: [order('order_A', 499000)] }),
      OPTIONS,
    );
    expect(cohort.members.map((m) => m.buyerId)).toEqual(['order_A']);
  });

  it('excludes an order that was paid', async () => {
    const cohort = await lapsedAuthorizationCohort(
      clientFor({ orders: [order('order_A', 499000, 'paid', 1)] }),
      OPTIONS,
    );
    expect(cohort.members).toHaveLength(0);
  });

  /**
   * The dangerous one. An order can sit in `attempted` while a payment against
   * it succeeded, so status alone is not enough — the payments have to be
   * checked, or the campaign discounts a completed sale.
   */
  it('excludes an unpaid-looking order that has a captured payment against it', async () => {
    const cohort = await lapsedAuthorizationCohort(
      clientFor({
        orders: [order('order_A', 499000, 'attempted', 1)],
        payments: [payment('pay_ok', 'order_A', 'captured')],
      }),
      OPTIONS,
    );
    expect(cohort.members).toHaveLength(0);
  });

  it('excludes one with a payment merely authorized, not yet captured', async () => {
    // Money is frozen against it. That buyer is mid-purchase, not lost.
    const cohort = await lapsedAuthorizationCohort(
      clientFor({
        orders: [order('order_A', 499000)],
        payments: [payment('pay_auth', 'order_A', 'authorized')],
      }),
      OPTIONS,
    );
    expect(cohort.members).toHaveLength(0);
  });

  it('includes an order whose only payment failed', async () => {
    const cohort = await lapsedAuthorizationCohort(
      clientFor({
        orders: [order('order_A', 499000, 'attempted', 1)],
        payments: [payment('pay_bad', 'order_A', 'failed')],
      }),
      OPTIONS,
    );
    expect(cohort.members).toHaveLength(1);
    expect(cohort.members[0]?.label).toContain('pay_bad');
    expect(cohort.members[0]?.label).toContain('card declined');
  });

  it('excludes ₹1 test orders below the floor', async () => {
    const cohort = await lapsedAuthorizationCohort(
      clientFor({ orders: [order('order_tiny', 100), order('order_real', 499000)] }),
      { ...OPTIONS, minAmountInr: 100 },
    );
    expect(cohort.members.map((m) => m.buyerId)).toEqual(['order_real']);
  });

  it('counts a buyer who failed twice on one order once', async () => {
    // Campaign spend is per member. Double-counting draws twice from the shared
    // budget for one recoverable sale.
    const cohort = await lapsedAuthorizationCohort(
      clientFor({
        orders: [order('order_A', 499000, 'attempted', 2)],
        payments: [payment('pay_1', 'order_A', 'failed'), payment('pay_2', 'order_A', 'failed')],
      }),
      OPTIONS,
    );
    expect(cohort.members).toHaveLength(1);
  });

  it('respects the limit', async () => {
    const orders = Array.from({ length: 30 }, (_, i) => order(`order_${i}`, 499000));
    const cohort = await lapsedAuthorizationCohort(clientFor({ orders }), { ...OPTIONS, limit: 5 });
    expect(cohort.members).toHaveLength(5);
  });
});

describe('what the cohort records about itself', () => {
  it('names its source, so the audit row can say where the names came from', async () => {
    const cohort = await lapsedAuthorizationCohort(
      clientFor({ orders: [order('order_A', 499000)] }),
      OPTIONS,
    );
    expect(cohort.source).toBe('razorpay_lapsed_authorizations');
  });

  it('carries the Razorpay ids it was built from', async () => {
    const cohort = await lapsedAuthorizationCohort(
      clientFor({
        orders: [order('order_A', 499000)],
        payments: [payment('pay_bad', 'order_A', 'failed')],
      }),
      OPTIONS,
    );
    expect(cohort.evidence).toContain('order_A');
    expect(cohort.evidence).toContain('pay_bad');
  });

  /**
   * The property this whole file exists for. An empty account produces an empty
   * campaign, and a campaign over no members does nothing. A cohort builder that
   * padded its results with plausible-looking buyers would be exactly the thing
   * the synthetic cohort was honest about being.
   */
  it('returns nobody when the account has nobody, and invents no one', async () => {
    const cohort = await lapsedAuthorizationCohort(clientFor({}), OPTIONS);
    expect(cohort.members).toEqual([]);
    expect(cohort.evidence).toEqual([]);
  });
});

describe('halted subscriptions', () => {
  it('includes only subscriptions Razorpay actually halted', async () => {
    const cohort = await haltedSubscriptionCohort(
      clientFor({
        subscriptions: [
          { id: 'sub_1', status: 'halted', plan_id: 'plan_1', paid_count: 3 },
          { id: 'sub_2', status: 'created', plan_id: 'plan_1', paid_count: 0 },
          { id: 'sub_3', status: 'active', plan_id: 'plan_1', paid_count: 7 },
        ],
      }),
      { sku: 'SKU-ESPRESSO-PRO' },
    );
    expect(cohort.members.map((m) => m.buyerId)).toEqual(['sub_1']);
  });

  /**
   * The state this account is actually in. Getting a halted subscription needs a
   * human authorizing the mandate and then four charge failures — a sequence no
   * API performs — so this function can be entirely correct and still return
   * nothing, and the campaign has to do something sensible with that.
   */
  it('returns an empty cohort when nothing has been halted, rather than failing', async () => {
    const cohort = await haltedSubscriptionCohort(
      clientFor({ subscriptions: [{ id: 'sub_1', status: 'created', plan_id: 'p', paid_count: 0 }] }),
      { sku: 'SKU-ESPRESSO-PRO' },
    );
    expect(cohort.members).toEqual([]);
    expect(cohort.source).toBe('razorpay_subscriptions');
  });
});
