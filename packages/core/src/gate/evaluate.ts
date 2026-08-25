/**
 * The mandate gate.
 *
 * Deterministic code holding a signed envelope. It takes a proposal, checks it
 * against every applicable clause, and either signs it or refuses citing the
 * clause by name. The model's output reaches this function as data and leaves it
 * either bound or rejected. Nothing in between is commercial.
 *
 * HOW THE CITED CLAUSE IS CHOSEN
 *
 * Every clause that limits discount depth contributes a ceiling. The gate
 * collects them all, takes the minimum, and cites whichever clause produced it.
 * That is what makes `authorized_by` worth reading: it names the constraint that
 * actually bound the decision, not the first one checked or all of them at once.
 * A row citing every clause the gate happened to evaluate is as uninformative as
 * one citing none.
 *
 * The same machinery produces a counter-offer for free. When a proposal exceeds
 * the binding ceiling, the gate already knows what the ceiling is, so a refusal
 * carries the depth it *would* have signed. Refusals are productive: the agent
 * re-proposes at the counter instead of guessing.
 */

import { signPayload } from '../crypto/sign.js';
import type { JsonObject } from '../crypto/canonical.js';
import type { KeyPair } from '../crypto/keys.js';
import {
  ZERO,
  addPaise,
  applyDepth,
  depthPctOf,
  formatInr,
  marginPctAt,
  mulPaise,
  paise,
  paiseToRupees,
  rupeesToPaise,
  subPaise,
  type Paise,
} from '../money.js';
import { limitsOf, type MandateLimits } from '../mandate/issue.js';
import { skuIsEligible, type ClausePath, type SellingMandate } from '../mandate/schema.js';
import { pressureCeilingPct, type PressureSnapshot } from '../pressure/reduce.js';
import type { SkuPricing } from '../catalog/schema.js';
import {
  available,
  drawnByBuyer,
  reserve,
  type BudgetState,
} from '../budget/ledger.js';
import {
  OFFER_VERSION,
  brandAsSigned,
  type OfferBody,
  type OfferLine,
  type Proposal,
  type QuoteProposal,
  type RefundAuthorization,
  type RefundProposal,
  type SignedOffer,
} from './offer.js';

export interface GateContext {
  readonly mandate: SellingMandate;
  readonly gateKey: KeyPair;
  /** Pricing for every SKU the agent may quote, keyed by SKU. */
  readonly pricing: ReadonlyMap<string, SkuPricing>;
  readonly budget: BudgetState;
  readonly pressure: PressureSnapshot;
  readonly now: Date;
  /** How long a signed quote stays live. Also the budget reservation TTL. */
  readonly quoteTtlMs?: number;
  /** Supplied by the caller so offer ids are deterministic under replay. */
  readonly offerId?: string;
}

export interface Refusal {
  readonly clause: ClausePath;
  readonly reason: string;
  /**
   * What the gate would sign instead. Present whenever a lower depth would
   * have passed, absent when nothing would (an excluded SKU, an invalid
   * mandate, an exhausted budget).
   */
  readonly counter?: { readonly depthPct: number; readonly totalInr: number };
}

export type QuoteDecision =
  | {
      readonly ok: true;
      readonly offer: SignedOffer;
      readonly budget: BudgetState;
      readonly clause: ClausePath;
    }
  | { readonly ok: false; readonly refusal: Refusal };

export type RefundDecision =
  | { readonly ok: true; readonly authorization: RefundAuthorization }
  | { readonly ok: false; readonly refusal: Refusal };

const DEFAULT_QUOTE_TTL_MS = 15 * 60 * 1000;

/** A ceiling on discount depth, and the clause responsible for it. */
interface Constraint {
  readonly clause: ClausePath;
  readonly ceilingPct: number;
  readonly reason: string;
}

export function evaluate(proposal: Proposal, context: GateContext): QuoteDecision | RefundDecision {
  return proposal.kind === 'quote'
    ? evaluateQuote(proposal, context)
    : evaluateRefund(proposal, context);
}

export function evaluateQuote(proposal: QuoteProposal, context: GateContext): QuoteDecision {
  const { mandate, now } = context;
  const limits = limitsOf(mandate);

  const envelopeProblem = checkEnvelope(context);
  if (envelopeProblem !== null) return { ok: false, refusal: envelopeProblem };

  if (proposal.lines.length === 0) {
    return {
      ok: false,
      refusal: { clause: 'authority.eligible_skus', reason: 'a quote must contain at least one line' },
    };
  }

  // --- resolve pricing and check per-SKU eligibility ------------------------
  const resolved: Array<{ pricing: SkuPricing; quantity: number }> = [];
  for (const line of proposal.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      return {
        ok: false,
        refusal: {
          clause: 'authority.bundle_rules.max_items',
          reason: `quantity for ${line.sku} must be a positive whole number`,
        },
      };
    }

    const pricing = context.pricing.get(line.sku);
    if (pricing === undefined) {
      return {
        ok: false,
        refusal: {
          clause: 'authority.eligible_skus',
          reason: `${line.sku} is not in the catalog, so the gate has no price or cost to check against`,
        },
      };
    }
    if (!skuIsEligible(line.sku, mandate.authority)) {
      const excluded = mandate.authority.excluded_skus.some((p) => matches(line.sku, p));
      return {
        ok: false,
        refusal: {
          clause: excluded ? 'authority.excluded_skus' : 'authority.eligible_skus',
          reason: excluded
            ? `${line.sku} is excluded from this mandate`
            : `${line.sku} is not covered by any eligible SKU pattern`,
        },
      };
    }
    if (!pricing.agentPurchasable) {
      return {
        ok: false,
        refusal: {
          clause: 'authority.eligible_skus',
          reason: `${line.sku} is not marked agent-purchasable in the catalog`,
        },
      };
    }
    if (pricing.availability !== 'in_stock') {
      return {
        ok: false,
        refusal: {
          clause: 'authority.eligible_skus',
          reason: `${line.sku} is ${pricing.availability}`,
        },
      };
    }
    if (line.quantity > pricing.maxQuantityPerOrder) {
      return {
        ok: false,
        refusal: {
          clause: 'authority.bundle_rules.max_items',
          reason: `${line.sku} allows at most ${pricing.maxQuantityPerOrder} per order`,
        },
      };
    }

    resolved.push({ pricing, quantity: line.quantity });
  }

  const totalUnits = resolved.reduce((sum, line) => sum + line.quantity, 0);
  const isBundle = totalUnits > 1;

  if (isBundle && totalUnits > limits.bundleMaxItems) {
    return {
      ok: false,
      refusal: {
        clause: 'authority.bundle_rules.max_items',
        reason: `a bundle may hold at most ${limits.bundleMaxItems} units, this one holds ${totalUnits}`,
      },
    };
  }

  const listTotal = resolved.reduce<Paise>(
    (sum, line) => addPaise(sum, mulPaise(line.pricing.listPrice, line.quantity)),
    ZERO,
  );
  const costTotal = resolved.reduce<Paise>(
    (sum, line) => addPaise(sum, mulPaise(line.pricing.unitCost, line.quantity)),
    ZERO,
  );

  if (listTotal === 0) {
    return {
      ok: false,
      refusal: { clause: 'authority.floor_margin_pct', reason: 'a zero-value quote has no margin to check' },
    };
  }

  // --- collect every ceiling, then take the tightest ------------------------
  const constraints = collectConstraints({
    context,
    limits,
    resolved,
    isBundle,
    listTotal,
    costTotal,
    buyerId: proposal.buyerId,
  });

  const binding = constraints.reduce((tightest, candidate) =>
    candidate.ceilingPct < tightest.ceilingPct ? candidate : tightest,
  );

  const requested = proposal.requestedDepthPct;
  if (!Number.isFinite(requested) || requested < 0 || requested > 100) {
    return {
      ok: false,
      refusal: {
        clause: 'authority.max_discount_depth_pct',
        reason: `requested depth ${requested} is not a percentage`,
      },
    };
  }

  if (requested > binding.ceilingPct + 1e-9) {
    return {
      ok: false,
      refusal: {
        clause: binding.clause,
        reason: binding.reason,
        ...(binding.ceilingPct > 0
          ? {
              counter: {
                depthPct: round2(binding.ceilingPct),
                totalInr: paiseToRupees(applyDepth(listTotal, binding.ceilingPct)),
              },
            }
          : {}),
      },
    };
  }

  const offeredTotal = applyDepth(listTotal, requested);
  const discount = subPaise(listTotal, offeredTotal);

  /**
   * Margin is re-checked on the realised total rather than trusted from the
   * ceiling arithmetic. Rounding happens between the two, and a floor that holds
   * in percentages but not in paise is not a floor.
   *
   * The check applies only to actual concessions. `floor_margin_pct` governs how
   * far the agent may concede, not whether the merchant's own list price is
   * profitable. A SKU listed below its floor margin is a pricing problem for the
   * merchant to fix; refusing to sell it at list would mean the gate blocking a
   * sale at a price the merchant themselves set, and would contradict the case
   * the whole design is built around — under total collapse the agent still
   * closes at list. Zero concession authority, not zero ability to transact.
   */
  if (discount > 0 && costTotal > 0 && marginPctAt(offeredTotal, costTotal) < limits.floorMarginPct - 1e-9) {
    return {
      ok: false,
      refusal: {
        clause: 'authority.floor_margin_pct',
        reason:
          `at ${formatInr(offeredTotal)} the margin is ` +
          `${marginPctAt(offeredTotal, costTotal).toFixed(1)}%, below the ${limits.floorMarginPct}% floor`,
      },
    };
  }

  // --- hold the budget ------------------------------------------------------
  const ttl = context.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  const offerId = context.offerId ?? `off_${now.getTime().toString(36)}_${shortHash(proposal.buyerId)}`;

  const held = reserve(
    context.budget,
    { id: offerId, amount: discount, buyerId: proposal.buyerId, purpose: 'negotiation', ttlMs: ttl },
    now,
  );
  if (!held.ok) {
    return {
      ok: false,
      refusal: {
        clause: 'authority.discount_budget_inr_per_day',
        reason: `${held.detail} (${formatInr(held.available)} of ${formatInr(limits.dailyDiscountBudget)} left today)`,
      },
    };
  }

  const lines: OfferLine[] = resolved.map(({ pricing, quantity }) => ({
    sku: pricing.sku,
    quantity,
    list_unit_price_inr: paiseToRupees(pricing.listPrice),
    offered_unit_price_inr: paiseToRupees(applyDepth(pricing.listPrice, requested)),
  }));

  const body: OfferBody = {
    version: OFFER_VERSION,
    offer_id: offerId,
    envelope_id: mandate.envelope_id,
    merchant_id: mandate.merchant_id,
    buyer_id: proposal.buyerId,
    currency: 'INR',
    lines,
    list_total_inr: paiseToRupees(listTotal),
    offered_total_inr: paiseToRupees(offeredTotal),
    depth_pct: round2(depthPctOf(listTotal, offeredTotal)),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl).toISOString(),
    settlement_path: proposal.settlementPath ?? 'pre_auth',
    ...(proposal.postAuthReason !== undefined ? { post_auth_reason: proposal.postAuthReason } : {}),
    authorized_by: binding.clause,
    reservation_id: offerId,
    pressure_score: round2(context.pressure.score),
  };

  const signed = signPayload(body as unknown as JsonObject, context.gateKey, now);

  return {
    ok: true,
    offer: brandAsSigned(signed as unknown as OfferBody & { signature: typeof signed.signature }),
    budget: held.state,
    clause: binding.clause,
  };
}

interface ConstraintInput {
  readonly context: GateContext;
  readonly limits: MandateLimits;
  readonly resolved: ReadonlyArray<{ pricing: SkuPricing; quantity: number }>;
  readonly isBundle: boolean;
  readonly listTotal: Paise;
  readonly costTotal: Paise;
  readonly buyerId: string;
}

function collectConstraints(input: ConstraintInput): Constraint[] {
  const { context, limits, resolved, isBundle, listTotal, costTotal, buyerId } = input;
  const constraints: Constraint[] = [];

  // The mandate's own depth ceiling. Bundles get their own, usually looser.
  constraints.push(
    isBundle
      ? {
          clause: 'authority.bundle_rules.combined_depth_pct',
          ceilingPct: limits.bundleCombinedDepthPct,
          reason: `a bundle may be discounted at most ${limits.bundleCombinedDepthPct}%`,
        }
      : {
          clause: 'authority.max_discount_depth_pct',
          ceilingPct: limits.maxDiscountDepthPct,
          reason: `a single item may be discounted at most ${limits.maxDiscountDepthPct}%`,
        },
  );

  /**
   * Confidence-gated margin authority.
   *
   * If the extractor was not confident about what a SKU costs, the agent may not
   * discount it — it cannot know the discount is affordable. The weakest SKU in
   * the bundle governs, because a confident cost on two items does not make a
   * guessed cost on the third safe to discount around.
   */
  const leastConfident = resolved.reduce((worst, line) =>
    line.pricing.marginConfidence < worst.pricing.marginConfidence ? line : worst,
  );
  if (leastConfident.pricing.marginConfidence < limits.minMarginConfidence) {
    constraints.push({
      clause: 'confidence_policy.min_margin_confidence',
      ceilingPct: limits.lowConfidenceDepthPct,
      reason:
        `margin confidence for ${leastConfident.pricing.sku} is ` +
        `${leastConfident.pricing.marginConfidence.toFixed(2)}, below the ` +
        `${limits.minMarginConfidence} threshold — the agent may not discount what it cannot price`,
    });
  }

  // Adversarial pressure tightens authority. Never loosens it.
  const pressureCeiling = pressureCeilingPct(
    context.pressure.state,
    isBundle ? limits.bundleCombinedDepthPct : limits.maxDiscountDepthPct,
  );
  if (context.pressure.state !== 'NORMAL') {
    constraints.push({
      clause:
        context.pressure.state === 'COLLAPSED'
          ? 'pressure_policy.collapse_threshold'
          : 'pressure_policy.guard_threshold',
      ceilingPct: pressureCeiling,
      reason:
        context.pressure.state === 'COLLAPSED'
          ? `manipulation pressure ${context.pressure.score.toFixed(2)} crossed the collapse threshold — discount authority is zero`
          : `manipulation pressure ${context.pressure.score.toFixed(2)} crossed the guard threshold — discount authority is halved`,
    });
  }

  // The floor margin, expressed as the deepest discount that still clears it.
  if (costTotal > 0) {
    constraints.push({
      clause: 'authority.floor_margin_pct',
      ceilingPct: depthCeilingFromMargin(listTotal, costTotal, limits.floorMarginPct),
      reason: `the ${limits.floorMarginPct}% floor margin does not permit a deeper discount on this basket`,
    });
  }

  // Per-buyer cap, expressed as depth.
  const alreadyDrawn = drawnByBuyer(context.budget, buyerId, context.now);
  const buyerHeadroom =
    alreadyDrawn >= limits.perBuyerDiscountCap ? ZERO : subPaise(limits.perBuyerDiscountCap, alreadyDrawn);
  constraints.push({
    clause: 'authority.per_buyer_discount_cap_inr',
    ceilingPct: depthCeilingFromAmount(listTotal, buyerHeadroom),
    reason:
      `this buyer has drawn ${formatInr(alreadyDrawn)} of their ` +
      `${formatInr(limits.perBuyerDiscountCap)} cap, leaving ${formatInr(buyerHeadroom)}`,
  });

  // Remaining daily pool, expressed as depth. Campaigns spend from here too.
  const poolLeft = available(context.budget, context.now);
  constraints.push({
    clause: 'authority.discount_budget_inr_per_day',
    ceilingPct: depthCeilingFromAmount(listTotal, poolLeft),
    reason:
      `${formatInr(poolLeft)} of the ${formatInr(limits.dailyDiscountBudget)} daily discount budget remains`,
  });

  return constraints;
}

/** The deepest discount on `listTotal` that still leaves `floorPct` margin over `costTotal`. */
function depthCeilingFromMargin(listTotal: Paise, costTotal: Paise, floorPct: number): number {
  if (floorPct >= 100) return 0;
  const minimumRevenue = costTotal / (1 - floorPct / 100);
  if (minimumRevenue >= listTotal) return 0;
  return ((listTotal - minimumRevenue) / listTotal) * 100;
}

/** The depth that spends exactly `budget` on a basket listing at `listTotal`. */
function depthCeilingFromAmount(listTotal: Paise, budget: Paise): number {
  if (listTotal === 0) return 0;
  return Math.min(100, (budget / listTotal) * 100);
}

export function evaluateRefund(proposal: RefundProposal, context: GateContext): RefundDecision {
  const limits = limitsOf(context.mandate);

  const envelopeProblem = checkEnvelope(context);
  if (envelopeProblem !== null) return { ok: false, refusal: envelopeProblem };

  const captured = rupeesToPaise(proposal.capturedAmountInr);
  const refund = rupeesToPaise(proposal.refundAmountInr);

  if (refund <= 0) {
    return {
      ok: false,
      refusal: { clause: 'authority.refund_authority.partial', reason: 'a refund must be for a positive amount' },
    };
  }
  if (refund > captured) {
    return {
      ok: false,
      refusal: {
        clause: 'authority.refund_authority.full_above_inr',
        reason: `cannot refund ${formatInr(refund)} against a captured ${formatInr(captured)}`,
      },
    };
  }

  const isPartial = refund < captured;

  if (isPartial && !limits.partialRefundsAllowed) {
    return {
      ok: false,
      refusal: {
        clause: 'authority.refund_authority.partial',
        reason: 'this mandate does not authorize partial refunds',
      },
    };
  }
  if (!isPartial && captured < limits.fullRefundAbove) {
    return {
      ok: false,
      refusal: {
        clause: 'authority.refund_authority.full_above_inr',
        reason: `full refunds are authorized only above ${formatInr(limits.fullRefundAbove)}`,
      },
    };
  }

  /**
   * Above the human threshold the gate does not refuse — it authorizes with a
   * human in the loop. A refusal would strand a legitimate refund; an
   * unconditional signature would hand away money nobody approved.
   */
  const requiresHuman = refund > limits.refundRequiresHumanAbove;

  return {
    ok: true,
    authorization: {
      payment_id: proposal.paymentId,
      refund_amount_inr: paiseToRupees(refund),
      is_partial: isPartial,
      authorized_by: requiresHuman
        ? 'authority.refund_authority.requires_human_above_inr'
        : isPartial
          ? 'authority.refund_authority.partial'
          : 'authority.refund_authority.full_above_inr',
      requires_human: requiresHuman,
    },
  };
}

/**
 * Is this gate entitled to act under this envelope at all?
 *
 * Checked before anything commercial. An expired mandate or one delegating to a
 * different key grants nothing, and finding that out after computing a price
 * would risk logging an authority that was never held.
 */
function checkEnvelope(context: GateContext): Refusal | null {
  const { mandate, gateKey, now } = context;

  if (gateKey.role !== 'gate') {
    return { clause: 'envelope.gate_key', reason: `signing requires a gate key, got a ${gateKey.role} key` };
  }
  if (mandate.gate_key.kid !== gateKey.kid) {
    return {
      clause: 'envelope.gate_key',
      reason: `this envelope delegates to gate ${mandate.gate_key.kid}, not ${gateKey.kid}`,
    };
  }
  const at = now.getTime();
  if (at >= Date.parse(mandate.expires_at)) {
    return { clause: 'envelope.expires_at', reason: `the mandate expired at ${mandate.expires_at}` };
  }
  if (at < Date.parse(mandate.issued_at)) {
    return { clause: 'envelope.expires_at', reason: `the mandate is not valid until ${mandate.issued_at}` };
  }
  return null;
}

function matches(sku: string, pattern: string): boolean {
  const escaped = pattern
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(sku);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 6);
}

/** Re-export so callers do not have to reach into money.ts for paise. */
export { paise, type Paise };
