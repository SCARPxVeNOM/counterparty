/**
 * Campaign orchestration — the same primitive, aimed outward.
 *
 * A negotiation authorizes discount spend one-to-one; a campaign authorizes it
 * one-to-many. Identical envelope, identical gate, identical signature. Only the
 * addressing changes.
 *
 * That is not a slogan here, it is the implementation: `runCampaign` calls the
 * same `evaluateQuote` a negotiation turn calls, threading the same
 * `BudgetState` through every member. There is no campaign-specific path
 * through the gate, no campaign-specific clause, and no second budget. Burn
 * ₹28k winning back lapsed subscribers in the morning and the selling agent has
 * ₹28k less to concede with in the afternoon — and its refusals say so, citing
 * the depleted clause by name.
 *
 * WHAT HAPPENS WHEN THE BUDGET RUNS OUT MID-CAMPAIGN
 *
 * The campaign stops itself. Members reached before the pool empties get signed
 * offers; members after it get refusals citing
 * `authority.discount_budget_inr_per_day`, and both land in the audit trail. A
 * campaign that silently truncated, or that kept spending past its authority,
 * would be the exact failure this system exists to make impossible — so the
 * boundary is a row in the ledger, not a log line.
 */

import {
  append,
  evaluateQuote,
  openLedger,
  paiseToRupees,
  poolPosition,
  rupeesToPaise,
  INITIAL_PRESSURE,
  type AuditLedger,
  type BudgetState,
  type KeyPair,
  type Refusal,
  type SellingMandate,
  type SignedOffer,
  type SkuPricing,
} from '@counterparty/core';

/**
 * Where a segment came from.
 *
 * `synthetic` is not a debug flag — it rides into every audit row this campaign
 * writes. A win-back campaign against a made-up audience is a legitimate thing
 * to demo and an illegitimate thing to present as real, and the difference has
 * to survive into the artifact rather than living in someone's memory of how
 * the demo was set up.
 */
export const SEGMENT_SOURCES = ['razorpay_subscriptions', 'razorpay_lapsed_authorizations', 'synthetic'] as const;
export type SegmentSource = (typeof SEGMENT_SOURCES)[number];

export interface SegmentMember {
  readonly buyerId: string;
  /** Human-readable reason this buyer is in the segment. */
  readonly label: string;
  readonly sku: string;
  readonly quantity: number;
}

export interface Segment {
  readonly id: string;
  readonly name: string;
  readonly source: SegmentSource;
  readonly members: readonly SegmentMember[];
}

export function isSynthetic(segment: Segment): boolean {
  return segment.source === 'synthetic';
}

export interface CampaignOptions {
  readonly campaignId: string;
  readonly mandate: SellingMandate;
  readonly gateKey: KeyPair;
  readonly catalog: ReadonlyMap<string, SkuPricing>;
  readonly budget: BudgetState;
  readonly segment: Segment;
  /** The concession the campaign wants to offer every member. */
  readonly depthPct: number;
  readonly rationale: string;
  readonly now?: Date;
  /** How long each campaign offer stays live. Defaults to 7 days. */
  readonly ttlMs?: number;
}

export interface CampaignOutcome {
  readonly member: SegmentMember;
  readonly offer?: SignedOffer;
  readonly refusal?: Refusal;
}

export interface CampaignResult {
  readonly campaignId: string;
  readonly segment: Segment;
  readonly outcomes: readonly CampaignOutcome[];
  readonly budget: BudgetState;
  readonly ledger: AuditLedger;
  readonly reached: number;
  readonly refused: number;
  readonly committedInr: number;
  /** True when the pool emptied before every member was reached. */
  readonly stoppedEarly: boolean;
  readonly synthetic: boolean;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Run a campaign against a segment.
 *
 * Pure with respect to the rails — it decides and records, and produces signed
 * offers. Turning those into payment links is the rails adapter's job, and it
 * takes only `SignedOffer`, so nothing here can address a member at a price the
 * gate did not authorize.
 */
export function runCampaign(options: CampaignOptions): CampaignResult {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? SEVEN_DAYS_MS;
  const synthetic = isSynthetic(options.segment);

  let budget = options.budget;
  let ledger = openLedger();
  const outcomes: CampaignOutcome[] = [];

  let reached = 0;
  let refused = 0;
  let committed = 0;

  for (const [index, member] of options.segment.members.entries()) {
    const offerId = `${options.campaignId}_m${String(index + 1).padStart(3, '0')}`;

    const decision = evaluateQuote(
      {
        kind: 'quote',
        buyerId: member.buyerId,
        lines: [{ sku: member.sku, quantity: member.quantity }],
        requestedDepthPct: options.depthPct,
        rationale: options.rationale,
      },
      {
        mandate: options.mandate,
        gateKey: options.gateKey,
        pricing: options.catalog,
        budget,
        // A campaign has no conversation, so no manipulation pressure to score.
        // It still passes through the pressure clause, which reads NORMAL.
        pressure: INITIAL_PRESSURE,
        now,
        offerId,
        quoteTtlMs: ttlMs,
      },
    );

    const position = poolPosition(budget, now);

    if (!decision.ok) {
      refused += 1;
      outcomes.push({ member, refusal: decision.refusal });
      ledger = append(ledger, {
        at: now.toISOString(),
        action: 'quote_refused',
        session_id: options.campaignId,
        envelope_id: options.mandate.envelope_id,
        outcome: 'refused',
        authorized_by: decision.refusal.clause,
        agent_rationale: describe(options, member, synthetic, decision.refusal.reason),
        buyer_id: member.buyerId,
        pressure_score: 0,
        budget_remaining_inr: paiseToRupees(position.remaining),
        budget_limit_inr: paiseToRupees(position.limit),
      });
      continue;
    }

    budget = decision.budget;
    reached += 1;
    committed += decision.offer.list_total_inr - decision.offer.offered_total_inr;
    outcomes.push({ member, offer: decision.offer });

    const after = poolPosition(budget, now);
    ledger = append(ledger, {
      at: now.toISOString(),
      action: 'campaign_offer_issued',
      session_id: options.campaignId,
      envelope_id: options.mandate.envelope_id,
      outcome: 'signed',
      authorized_by: decision.offer.authorized_by,
      agent_rationale: describe(options, member, synthetic),
      offer_id: decision.offer.offer_id,
      buyer_id: member.buyerId,
      amount_inr: decision.offer.offered_total_inr,
      list_inr: decision.offer.list_total_inr,
      depth_pct: decision.offer.depth_pct,
      settlement_path: decision.offer.settlement_path,
      signature: decision.offer.signature.sig,
      pressure_score: 0,
      budget_remaining_inr: paiseToRupees(after.remaining),
      budget_limit_inr: paiseToRupees(after.limit),
    });
  }

  return {
    campaignId: options.campaignId,
    segment: options.segment,
    outcomes,
    budget,
    ledger,
    reached,
    refused,
    committedInr: committed,
    stoppedEarly: refused > 0,
    synthetic,
  };
}

/**
 * The rationale recorded on every row.
 *
 * Prefixed when the segment is synthetic. A reader of this ledger six months
 * from now should not have to know how the demo was configured to tell whether
 * these were real customers.
 */
function describe(
  options: CampaignOptions,
  member: SegmentMember,
  synthetic: boolean,
  extra?: string,
): string {
  const prefix = synthetic ? '[SYNTHETIC SEGMENT] ' : '';
  const tail = extra === undefined ? '' : ` — ${extra}`;
  return `${prefix}${options.segment.name}: ${member.label}${tail}`;
}

/** Total discount a campaign would cost if every member were reached. */
export function campaignCostInr(
  segment: Segment,
  catalog: ReadonlyMap<string, SkuPricing>,
  depthPct: number,
): number {
  let total = 0;
  for (const member of segment.members) {
    const pricing = catalog.get(member.sku);
    if (pricing === undefined) continue;
    total += paiseToRupees(pricing.listPrice) * member.quantity * (depthPct / 100);
  }
  return Math.round(total * 100) / 100;
}

/** Convert a rupee figure to the paise the budget ledger works in. */
export { rupeesToPaise };
