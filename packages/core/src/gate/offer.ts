/**
 * Offers and proposals — the propose/bind separation, expressed as types.
 *
 * The selling agent reasons in natural language and emits a `Proposal`. A
 * proposal has no commercial force whatsoever; it is the model's opinion about
 * what would be a good deal. Only the gate can turn one into a `SignedOffer`,
 * and only the gate can construct that type.
 *
 * HOW STRONG IS THE GUARANTEE, EXACTLY
 *
 * `SignedOffer` carries a brand keyed on a `unique symbol` that this module
 * declares and does not export. No other module can name that key, so no other
 * module can build a value of this type. Every rails call — every function that
 * moves money — takes `SignedOffer` and nothing else. The result is that a
 * proposal cannot reach Razorpay by any ordinary code path: not by refactor, not
 * by a mistaken parameter order, not by someone plumbing the model's output one
 * function further than they should have. The compiler rejects it.
 *
 * What this does NOT do is stop a determined author writing
 * `proposal as unknown as SignedOffer`. TypeScript has no way to prevent that,
 * and claiming otherwise would be the same species of overclaim the audit trail
 * exists to prevent. What it buys is that the bypass must be explicit, is one
 * grep away, and cannot happen by accident — and the rails adapter verifies the
 * gate signature at runtime regardless, so a forged value fails there too.
 * Compile-time for accidents, signature verification for everything else.
 */

import type { Signature } from '../crypto/sign.js';
import type { ClausePath } from '../mandate/schema.js';

declare const SIGNED_BY_GATE: unique symbol;

export const OFFER_VERSION = 'counterparty/signed-offer/1' as const;

/** Which settlement route the gate authorized, and why. See docs/CORRECTIONS.md C1. */
export const SETTLEMENT_PATHS = ['pre_auth', 'post_auth'] as const;
export type SettlementPath = (typeof SETTLEMENT_PATHS)[number];

export const POST_AUTH_REASONS = ['partial_fulfilment', 'out_of_stock', 'post_sale_defect'] as const;
export type PostAuthReason = (typeof POST_AUTH_REASONS)[number];

export interface OfferLine {
  readonly sku: string;
  readonly quantity: number;
  readonly list_unit_price_inr: number;
  readonly offered_unit_price_inr: number;
}

export interface OfferBody {
  readonly version: typeof OFFER_VERSION;
  readonly offer_id: string;
  /** Which envelope authorized this. Authority that cannot be pointed at is not auditable. */
  readonly envelope_id: string;
  readonly merchant_id: string;
  readonly buyer_id: string;
  readonly currency: 'INR';
  readonly lines: readonly OfferLine[];
  readonly list_total_inr: number;
  readonly offered_total_inr: number;
  readonly depth_pct: number;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly settlement_path: SettlementPath;
  readonly post_auth_reason?: PostAuthReason;
  /**
   * The clause that bound this decision — the one that produced the tightest
   * applicable ceiling, not every clause that happened to be checked. Citing all
   * of them would be as uninformative as citing none.
   */
  readonly authorized_by: ClausePath;
  /** The budget reservation this offer holds while it is live. */
  readonly reservation_id: string;
  readonly pressure_score: number;
}

/**
 * A binding commercial commitment. Only `gate.evaluate()` can produce one.
 */
export type SignedOffer = OfferBody & {
  readonly signature: Signature;
  readonly [SIGNED_BY_GATE]: true;
};

/**
 * Internal — the one place a `SignedOffer` comes into existence. Not exported
 * from the package.
 */
export function brandAsSigned(body: OfferBody & { readonly signature: Signature }): SignedOffer {
  return body as SignedOffer;
}

/** Strip the brand for serialization. The wire format has no brand in it. */
export function offerToJson(offer: SignedOffer): OfferBody & { readonly signature: Signature } {
  return offer;
}

// ---------------------------------------------------------------------------
// Proposals — what the model is allowed to say
// ---------------------------------------------------------------------------

export interface ProposalLine {
  readonly sku: string;
  readonly quantity: number;
}

/**
 * A priced offer the agent would like to make.
 *
 * `rationale` is recorded in the audit row as `agent_rationale`. It explains the
 * commercial judgment; it never justifies the authority. The clause does that.
 */
export interface QuoteProposal {
  readonly kind: 'quote';
  readonly buyerId: string;
  readonly lines: readonly ProposalLine[];
  readonly requestedDepthPct: number;
  readonly rationale: string;
  readonly settlementPath?: SettlementPath;
  readonly postAuthReason?: PostAuthReason;
}

export interface RefundProposal {
  readonly kind: 'refund';
  readonly buyerId: string;
  readonly paymentId: string;
  readonly capturedAmountInr: number;
  readonly refundAmountInr: number;
  readonly rationale: string;
}

export type Proposal = QuoteProposal | RefundProposal;

/**
 * What the gate decided about a refund. Refunds do not draw on the discount
 * budget — money already changed hands — so they produce an authorization
 * rather than a signed price.
 */
export interface RefundAuthorization {
  readonly payment_id: string;
  readonly refund_amount_inr: number;
  readonly is_partial: boolean;
  readonly authorized_by: ClausePath;
  readonly requires_human: boolean;
}
