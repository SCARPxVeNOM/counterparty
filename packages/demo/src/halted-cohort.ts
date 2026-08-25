/**
 * A synthetic cohort of halted subscribers.
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 *
 * §7 aims win-back campaigns at subscriptions Razorpay halted after four
 * consecutive failed charges. That cohort is real and reproducible — Razorpay's
 * test guide documents the exact path, and their docs confirm that once halted,
 * "invoices for such Subscriptions are still created. However, we will not
 * charge these invoices. You will have to charge them manually." That last
 * sentence is why the segment matters: Razorpay hands the decision back to the
 * merchant, and there is currently no artifact proving the merchant authorized
 * whichever way it went.
 *
 * We cannot produce that cohort on this account. Subscriptions is not
 * provisioned — `/plans` and `/subscriptions` return `401 {"error":
 * "Unauthorized"}`, and the Dashboard's own Plans list shows "Something went
 * wrong", so it is not an API-key problem. You cannot halt a subscription that
 * was never created.
 *
 * So the members below are invented. Nothing else about the campaign is: the
 * envelope, the gate, every clause check, the Ed25519 signatures, the shared
 * budget and the hash-chained audit trail all execute exactly as they would
 * against real subscribers, because none of them are downstream of where the
 * buyer list came from.
 *
 * The `source: 'synthetic'` tag rides into every audit row this cohort produces.
 * A made-up audience is a legitimate thing to demo and an illegitimate thing to
 * present as real, and that difference has to survive into the artifact rather
 * than living in someone's memory of how the demo was set up.
 *
 * Replacing this with the real thing is one function: list subscriptions with
 * `status=halted`, map each to a `SegmentMember`, set the source. Everything
 * downstream is unchanged.
 */

import type { Segment, SegmentMember } from '@counterparty/agents';

interface HaltedSubscriber {
  readonly buyerId: string;
  readonly haltedOn: string;
  readonly monthlyInr: number;
  readonly failedCharges: number;
  readonly sku: string;
  readonly quantity: number;
}

/**
 * Twelve subscribers, deliberately more than the budget can serve at the
 * campaign's opening depth. The campaign is supposed to run out partway — that
 * is the behaviour worth demonstrating, not an edge case to design around.
 */
const HALTED: readonly HaltedSubscriber[] = [
  { buyerId: 'sub_hlt_0001', haltedOn: '2026-08-12', monthlyInr: 499, failedCharges: 4, sku: 'SKU-ESPRESSO-PRO', quantity: 1 },
  { buyerId: 'sub_hlt_0002', haltedOn: '2026-08-13', monthlyInr: 499, failedCharges: 4, sku: 'SKU-ESPRESSO-PRO', quantity: 1 },
  { buyerId: 'sub_hlt_0003', haltedOn: '2026-08-14', monthlyInr: 999, failedCharges: 4, sku: 'SKU-ESPRESSO-PRO', quantity: 1 },
  { buyerId: 'sub_hlt_0004', haltedOn: '2026-08-15', monthlyInr: 499, failedCharges: 5, sku: 'SKU-KETTLE-1L', quantity: 2 },
  { buyerId: 'sub_hlt_0005', haltedOn: '2026-08-16', monthlyInr: 499, failedCharges: 4, sku: 'SKU-ESPRESSO-PRO', quantity: 1 },
  { buyerId: 'sub_hlt_0006', haltedOn: '2026-08-17', monthlyInr: 1499, failedCharges: 4, sku: 'SKU-ESPRESSO-PRO', quantity: 1 },
  { buyerId: 'sub_hlt_0007', haltedOn: '2026-08-18', monthlyInr: 499, failedCharges: 4, sku: 'SKU-KETTLE-1L', quantity: 3 },
  { buyerId: 'sub_hlt_0008', haltedOn: '2026-08-19', monthlyInr: 999, failedCharges: 6, sku: 'SKU-ESPRESSO-PRO', quantity: 1 },
  { buyerId: 'sub_hlt_0009', haltedOn: '2026-08-20', monthlyInr: 499, failedCharges: 4, sku: 'SKU-ESPRESSO-PRO', quantity: 1 },
  { buyerId: 'sub_hlt_0010', haltedOn: '2026-08-21', monthlyInr: 499, failedCharges: 4, sku: 'SKU-KETTLE-1L', quantity: 1 },
  { buyerId: 'sub_hlt_0011', haltedOn: '2026-08-22', monthlyInr: 999, failedCharges: 4, sku: 'SKU-ESPRESSO-PRO', quantity: 1 },
  { buyerId: 'sub_hlt_0012', haltedOn: '2026-08-23', monthlyInr: 499, failedCharges: 4, sku: 'SKU-ESPRESSO-PRO', quantity: 1 },
];

function toMember(subscriber: HaltedSubscriber): SegmentMember {
  return {
    buyerId: subscriber.buyerId,
    label: `halted ${subscriber.haltedOn} after ${subscriber.failedCharges} failed charges, ₹${subscriber.monthlyInr}/mo`,
    sku: subscriber.sku,
    quantity: subscriber.quantity,
  };
}

/**
 * The win-back segment.
 *
 * `limit` exists so a scenario can show the campaign completing on a small
 * cohort and running out of budget on a large one, without needing two
 * different fixtures.
 */
export function syntheticHaltedCohort(limit?: number): Segment {
  const members = (limit === undefined ? HALTED : HALTED.slice(0, limit)).map(toMember);
  return {
    id: 'seg_halted_winback',
    name: 'Halted subscribers — win-back',
    source: 'synthetic',
    members,
  };
}

/**
 * §7's other named target: authorizations the agent deliberately let lapse.
 *
 * These are buyers whose payment was authorized and then intentionally not
 * captured within Razorpay's 3-day window — fulfilment failed, stock ran out —
 * so Razorpay auto-refunded them. They wanted the item and did not get it,
 * which makes them a better win-back audience than a cold list.
 *
 * Synthetic for the same reason as the halted cohort: producing real ones needs
 * real authorized payments, and the authorize step on this account is still
 * simulated. Fresh buyer ids, so this cohort has not already drawn against the
 * per-buyer cap.
 */
export function syntheticLapsedAuthorizations(count = 15): Segment {
  return {
    id: 'seg_lapsed_auth',
    name: 'Lapsed authorizations — win-back',
    source: 'synthetic',
    members: Array.from({ length: count }, (_, i) => ({
      buyerId: `auth_lapsed_${String(i + 1).padStart(4, '0')}`,
      label: `authorization lapsed uncaptured, auto-refunded after 72h`,
      sku: 'SKU-ESPRESSO-PRO',
      quantity: 1,
    })),
  };
}

/**
 * How the same segment would be built from live data, once Subscriptions is
 * provisioned. Kept next to the synthetic version so the swap is visibly small
 * rather than a rewrite.
 *
 *   const halted = await rails.listSubscriptions({ status: 'halted' });
 *   return {
 *     id: 'seg_halted_winback',
 *     name: 'Halted subscribers — win-back',
 *     source: 'razorpay_subscriptions',
 *     members: halted.map((s) => ({
 *       buyerId: s.id,
 *       label: `halted ${s.halted_at}, ₹${s.plan_amount / 100}/mo`,
 *       sku: skuForPlan(s.plan_id),
 *       quantity: 1,
 *     })),
 *   };
 */
export const LIVE_COHORT_SKETCH = 'see the comment above — the swap is the members array and the source tag';
