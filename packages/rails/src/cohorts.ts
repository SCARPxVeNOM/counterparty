/**
 * Win-back cohorts, read from the merchant's actual Razorpay account.
 *
 * §7 names two segments a campaign should aim at: **subscriptions halted after
 * four consecutive failed charges**, and **authorizations the agent deliberately
 * let lapse**. Both are recorded failures already sitting in the account, which
 * is the point of choosing them — a win-back campaign against a list somebody
 * typed out is a demo, and a win-back campaign against the merchant's own
 * abandoned checkouts is a product.
 *
 * The demo shipped an invented cohort for a long time, correctly labelled
 * `synthetic` in every audit row it produced. This is the replacement, and it
 * changes nothing downstream: the same `runCampaign`, the same envelope, the
 * same gate, the same shared budget. Only where the names came from is
 * different, and that difference is exactly what `source` records.
 *
 * WHAT COUNTS AS A LAPSED AUTHORIZATION
 *
 * An order that was created and never paid. Razorpay keeps it in `created` or
 * `attempted` forever — nothing expires it — so an order with no successful
 * payment against it is a checkout somebody walked away from. That is a real
 * recoverable customer, and it is the most common one any merchant has.
 *
 * Failed payments are included as their own reason: an order with a *failed*
 * attempt is a stronger signal than one with none. Somebody reached for their
 * card and the card said no. That buyer wanted the thing.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not invent members when the account has none. An empty account
 * produces an empty segment, and `runCampaign` over an empty segment does
 * nothing — which is the correct behaviour and the honest one. A cohort builder
 * that quietly pads its results with fictional buyers is the exact failure this
 * file was written to end.
 */

import type { RazorpayClient } from './client';

/** The shape `@counterparty/agents` expects. Duplicated rather than imported: rails does not depend on agents. */
export interface CohortMember {
  readonly buyerId: string;
  readonly label: string;
  readonly sku: string;
  readonly quantity: number;
}

export interface Cohort {
  readonly id: string;
  readonly name: string;
  readonly source: 'razorpay_subscriptions' | 'razorpay_lapsed_authorizations';
  readonly members: readonly CohortMember[];
  /** Razorpay object ids this cohort was built from, for the audit trail. */
  readonly evidence: readonly string[];
}

export interface CohortOptions {
  /** What to offer these buyers. The campaign prices it; this just names it. */
  readonly sku: string;
  readonly quantity?: number;
  /** Cap the segment. Razorpay pages at 100. */
  readonly limit?: number;
  /** Ignore orders below this, in rupees — ₹1 test orders are not customers. */
  readonly minAmountInr?: number;
}

interface RawOrderRecord {
  readonly id: string;
  readonly amount: number;
  readonly status: string;
  readonly attempts: number;
  readonly created_at: number;
}

interface RawPaymentRecord {
  readonly id: string;
  readonly order_id: string | null;
  readonly status: string;
  readonly amount: number;
  readonly created_at: number;
  readonly error_description?: string | null;
}

const day = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toISOString().slice(0, 10);

/**
 * Orders that were never paid, and the failed attempts against them.
 *
 * One member per order, so a buyer who failed twice on the same order is one
 * customer rather than two. Campaign spend is per member, and double-counting
 * would draw twice from the shared budget for one recoverable sale.
 */
export async function lapsedAuthorizationCohort(
  client: RazorpayClient,
  options: CohortOptions,
): Promise<Cohort> {
  const limit = options.limit ?? 20;
  const minPaise = (options.minAmountInr ?? 100) * 100;

  const [orders, payments] = await Promise.all([
    client.get<{ items?: RawOrderRecord[] }>('/orders?count=100'),
    client.get<{ items?: RawPaymentRecord[] }>('/payments?count=100'),
  ]);

  /** Order ids with a payment that actually succeeded. Those buyers are not lost. */
  const settled = new Set(
    (payments.items ?? [])
      .filter((p) => p.status === 'captured' || p.status === 'authorized')
      .map((p) => p.order_id)
      .filter((id): id is string => id !== null),
  );

  const failedOn = new Map<string, RawPaymentRecord>();
  for (const payment of payments.items ?? []) {
    if (payment.status === 'failed' && payment.order_id !== null) {
      failedOn.set(payment.order_id, payment);
    }
  }

  const members: CohortMember[] = [];
  const evidence: string[] = [];

  for (const order of orders.items ?? []) {
    if (members.length >= limit) break;
    if (order.status === 'paid') continue;
    if (settled.has(order.id)) continue;
    if (order.amount < minPaise) continue;

    const failed = failedOn.get(order.id);
    const label =
      failed === undefined
        ? `abandoned checkout — ₹${order.amount / 100} on ${day(order.created_at)}, never attempted`
        : `failed payment ${failed.id} — ₹${order.amount / 100} on ${day(failed.created_at)}` +
          (failed.error_description == null ? '' : `, "${failed.error_description}"`);

    members.push({
      buyerId: order.id,
      label,
      sku: options.sku,
      quantity: options.quantity ?? 1,
    });
    evidence.push(order.id);
    if (failed !== undefined) evidence.push(failed.id);
  }

  return {
    id: 'seg_lapsed_live',
    name: 'Abandoned checkouts and failed payments',
    source: 'razorpay_lapsed_authorizations',
    members,
    evidence,
  };
}

/**
 * Subscriptions Razorpay halted after four consecutive failed charges.
 *
 * Returns empty until such a subscription exists. Getting one requires a human
 * authorizing the mandate at a card tap and then four Dashboard charge
 * failures — a sequence no API can perform, which is why this function can be
 * correct and still return nothing.
 */
export async function haltedSubscriptionCohort(
  client: RazorpayClient,
  options: CohortOptions,
): Promise<Cohort> {
  const limit = options.limit ?? 20;
  const response = await client.get<{
    items?: Array<{ id: string; status: string; plan_id: string; paid_count: number }>;
  }>('/subscriptions?count=100');

  const halted = (response.items ?? []).filter((s) => s.status === 'halted').slice(0, limit);

  return {
    id: 'seg_halted_live',
    name: 'Subscriptions halted after repeated charge failures',
    source: 'razorpay_subscriptions',
    members: halted.map((s) => ({
      buyerId: s.id,
      label: `halted subscription on plan ${s.plan_id}, ${s.paid_count} paid cycle(s)`,
      sku: options.sku,
      quantity: options.quantity ?? 1,
    })),
    evidence: halted.map((s) => s.id),
  };
}
