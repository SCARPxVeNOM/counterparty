/**
 * Envelope drafting.
 *
 * Two callers need to build an envelope body: the onboarding flow, which derives
 * one from an extracted catalog and hands it to a merchant to confirm, and tests
 * and demos, which need a known-good baseline to vary one clause at a time.
 *
 * The defaults are the reference envelope from the design note, unchanged, so
 * that what the pitch shows and what the code runs are the same document.
 */

import type { PublicKeyRef } from '../crypto/keys';
import type { UnsignedMandate } from './schema';
import { MANDATE_VERSION } from './schema';

export interface DraftMandateInput {
  readonly merchantId: string;
  readonly gateKey: PublicKeyRef;
  readonly envelopeId?: string;
  readonly issuedAt?: Date;
  readonly validForDays?: number;
  readonly authority?: Partial<UnsignedMandate['authority']>;
  readonly confidencePolicy?: Partial<UnsignedMandate['confidence_policy']>;
  readonly pressurePolicy?: Partial<UnsignedMandate['pressure_policy']>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function draftMandate(input: DraftMandateInput): UnsignedMandate {
  const issuedAt = input.issuedAt ?? new Date();
  const validForDays = input.validForDays ?? 31;

  if (input.gateKey.role !== 'gate') {
    throw new Error(`gate_key must be a gate key, got a ${input.gateKey.role} key`);
  }

  return {
    version: MANDATE_VERSION,
    envelope_id: input.envelopeId ?? `env_${issuedAt.getTime().toString(36)}`,
    merchant_id: input.merchantId,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + validForDays * DAY_MS).toISOString(),
    gate_key: {
      kid: input.gateKey.kid,
      public_key_pem: input.gateKey.publicKeyPem,
    },
    authority: {
      floor_margin_pct: 18,
      max_discount_depth_pct: 15,
      eligible_skus: ['SKU-*'],
      excluded_skus: ['SKU-CLEARANCE-*'],
      bundle_rules: { max_items: 3, combined_depth_pct: 20 },
      refund_authority: {
        partial: true,
        full_above_inr: 0,
        requires_human_above_inr: 5000,
      },
      capture_window_hours: 72,
      discount_budget_inr_per_day: 40000,
      per_buyer_discount_cap_inr: 2000,
      ...input.authority,
    },
    confidence_policy: {
      min_margin_confidence: 0.85,
      below_threshold_discount_depth_pct: 0,
      ...input.confidencePolicy,
    },
    pressure_policy: {
      collapse_threshold: 0.7,
      guard_threshold: 0.4,
      on_collapse: ['depth_pct=0', 'log_incident', 'notify_human'],
      ...input.pressurePolicy,
    },
  };
}
