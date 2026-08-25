/**
 * Issuing and verifying a selling mandate.
 *
 * Issuance is the merchant act: "I grant a gate holding this key the authority
 * described here, until this date." Verification is what anyone else does with
 * the result, including parties we do not control.
 *
 * Verification is deliberately staged, and the stages are not interchangeable.
 * Checking a signature on a document you have not schema-validated tells you the
 * bytes are authentic but not that they mean anything; validating a schema you
 * have not signature-checked tells you the document is well formed but not who
 * wrote it. Both, in that order, plus a clock check — an expired mandate is a
 * correctly signed document that no longer grants anything.
 */

import { signPayload, verifySigned, type VerifyFailure } from '../crypto/sign.js';
import type { JsonObject } from '../crypto/canonical.js';
import type { KeyPair, PublicKeyRef } from '../crypto/keys.js';
import { paise, rupeesToPaise, type Paise } from '../money.js';
import {
  SellingMandateSchema,
  UnsignedMandateSchema,
  type SellingMandate,
  type UnsignedMandate,
} from './schema.js';

export class MandateError extends Error {
  override readonly name = 'MandateError';
}

/**
 * Sign an envelope with the merchant key.
 *
 * The body is validated before signing. Signing an incoherent envelope would
 * produce an authentic document granting authority that can never be exercised,
 * and the gate would refuse everything while the signature checked out — the
 * most confusing possible failure.
 */
export function issueMandate(body: UnsignedMandate, merchantKey: KeyPair, issuedAt?: Date): SellingMandate {
  if (merchantKey.role !== 'merchant') {
    throw new MandateError(`a selling mandate must be signed by a merchant key, not a ${merchantKey.role} key`);
  }

  const parsed = UnsignedMandateSchema.safeParse(body);
  if (!parsed.success) {
    throw new MandateError(`envelope is not coherent: ${formatIssues(parsed.error)}`);
  }

  // The envelope names the gate key it delegates to. If that key were the
  // merchant's own, the separation between granting authority and exercising it
  // would be cosmetic.
  if (parsed.data.gate_key.kid === merchantKey.kid) {
    throw new MandateError(
      'gate_key is the merchant key — the authority to grant and the authority to exercise must be separate keys',
    );
  }

  return signPayload(parsed.data as JsonObject, merchantKey, issuedAt) as SellingMandate;
}

export type MandateVerification =
  | { readonly ok: true; readonly mandate: SellingMandate }
  | { readonly ok: false; readonly reason: 'schema'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'signature'; readonly detail: string; readonly failure: VerifyFailure }
  | { readonly ok: false; readonly reason: 'expired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_yet_valid'; readonly detail: string };

/**
 * Full verification chain for an envelope.
 *
 * This is what a buyer agent runs before trusting anything a selling agent says,
 * and what `counterparty verify` runs in front of a judge.
 */
export function verifyMandate(
  candidate: unknown,
  merchantPublicKey: PublicKeyRef,
  now: Date = new Date(),
): MandateVerification {
  const parsed = SellingMandateSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: 'schema', detail: formatIssues(parsed.error) };
  }
  const mandate = parsed.data;

  const signature = verifySigned(mandate as JsonObject, merchantPublicKey);
  if (!signature.ok) {
    return { ok: false, reason: 'signature', detail: signature.detail, failure: signature.reason };
  }

  const at = now.getTime();
  if (at < Date.parse(mandate.issued_at)) {
    return {
      ok: false,
      reason: 'not_yet_valid',
      detail: `mandate is issued from ${mandate.issued_at}, which is in the future`,
    };
  }
  if (at >= Date.parse(mandate.expires_at)) {
    return {
      ok: false,
      reason: 'expired',
      detail: `mandate expired at ${mandate.expires_at}`,
    };
  }

  return { ok: true, mandate };
}

/**
 * Rupee clauses converted to paise, once.
 *
 * The envelope is authored by a human in rupees. Everything downstream does
 * integer arithmetic in paise. This is the only place the two meet, so a unit
 * mix-up has exactly one place to hide.
 */
export interface MandateLimits {
  readonly floorMarginPct: number;
  readonly maxDiscountDepthPct: number;
  readonly bundleMaxItems: number;
  readonly bundleCombinedDepthPct: number;
  readonly dailyDiscountBudget: Paise;
  readonly perBuyerDiscountCap: Paise;
  readonly partialRefundsAllowed: boolean;
  readonly fullRefundAbove: Paise;
  readonly refundRequiresHumanAbove: Paise;
  readonly captureWindowMs: number;
  readonly minMarginConfidence: number;
  readonly lowConfidenceDepthPct: number;
  readonly collapseThreshold: number;
}

export function limitsOf(mandate: SellingMandate): MandateLimits {
  const { authority, confidence_policy: confidence, pressure_policy: pressure } = mandate;
  return {
    floorMarginPct: authority.floor_margin_pct,
    maxDiscountDepthPct: authority.max_discount_depth_pct,
    bundleMaxItems: authority.bundle_rules.max_items,
    bundleCombinedDepthPct: authority.bundle_rules.combined_depth_pct,
    dailyDiscountBudget: rupeesToPaise(authority.discount_budget_inr_per_day),
    perBuyerDiscountCap: rupeesToPaise(authority.per_buyer_discount_cap_inr),
    partialRefundsAllowed: authority.refund_authority.partial,
    fullRefundAbove: rupeesToPaise(authority.refund_authority.full_above_inr),
    refundRequiresHumanAbove: rupeesToPaise(authority.refund_authority.requires_human_above_inr),
    captureWindowMs: authority.capture_window_hours * 60 * 60 * 1000,
    minMarginConfidence: confidence.min_margin_confidence,
    lowConfidenceDepthPct: confidence.below_threshold_discount_depth_pct,
    collapseThreshold: pressure.collapse_threshold,
  };
}

/** Milliseconds of validity remaining. Zero once expired. */
export function remainingValidityMs(mandate: SellingMandate, now: Date = new Date()): number {
  return Math.max(0, Date.parse(mandate.expires_at) - now.getTime());
}

export const ZERO_PAISE: Paise = paise(0);

function formatIssues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
