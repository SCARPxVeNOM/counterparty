/**
 * The Selling Mandate — a signed, merchant-issued authority envelope.
 *
 * The mirror image of AP2's spending mandate. AP2 signs what the buyer
 * authorized; this signs what the merchant authorized. Every field is a clause
 * the gate can cite by name in an audit row, which is what makes "explainable"
 * real rather than decorative.
 *
 * Three fields exist here that are not in the original design note, each closing
 * a gap that would otherwise be demoed as a feature:
 *
 *   gate_key   The merchant delegates to a SPECIFIC gate key. Without this, an
 *              offer signed by any gate could claim to act under this envelope,
 *              and the verification chain has no anchor — a gate signature would
 *              prove only that some gate approved it, never that this merchant
 *              ever authorized that gate's limits.
 *
 *   envelope_id  So an offer and its audit row can name which envelope
 *              authorized them. Authority that cannot be pointed at is not
 *              auditable.
 *
 *   guard_threshold  The pressure ratchet needs an intermediate state. Going
 *              straight from full authority to total collapse gives the agent no
 *              room to tighten before it has to stop conceding entirely.
 */

import { z } from 'zod';

/** ISO 8601 instant. Validated by parsing rather than by regex. */
const IsoDateTime = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)) && /\d{4}-\d{2}-\d{2}T/.test(value),
  { message: 'must be an ISO 8601 datetime, e.g. 2026-08-24T10:00:00Z' },
);

const Pct = z.number().min(0).max(100);
const Unit = z.number().min(0).max(1);
const Rupees = z.number().int().min(0);

export const SIGNATURE_ROLES = ['merchant', 'gate'] as const;

export const SignatureSchema = z.object({
  alg: z.literal('Ed25519'),
  kid: z.string().regex(/^[0-9a-f]{16}$/),
  role: z.enum(SIGNATURE_ROLES),
  sig: z.string().min(1),
  signed_at: IsoDateTime,
});

export const GateKeySchema = z.object({
  kid: z.string().regex(/^[0-9a-f]{16}$/),
  public_key_pem: z.string().includes('BEGIN PUBLIC KEY'),
});

export const BundleRulesSchema = z.object({
  max_items: z.number().int().min(1),
  combined_depth_pct: Pct,
});

export const RefundAuthoritySchema = z.object({
  partial: z.boolean(),
  /** Full refunds are permitted above this order value. 0 means always. */
  full_above_inr: Rupees,
  /** Above this value a refund needs a human, whatever the agent thinks. */
  requires_human_above_inr: Rupees,
});

export const AuthoritySchema = z.object({
  floor_margin_pct: Pct,
  max_discount_depth_pct: Pct,
  eligible_skus: z.array(z.string().min(1)).min(1),
  excluded_skus: z.array(z.string().min(1)),
  bundle_rules: BundleRulesSchema,
  refund_authority: RefundAuthoritySchema,
  /**
   * Capped at 72 hours because Razorpay auto-refunds an uncaptured
   * authorization after 3 days. An envelope authorizing a longer window would be
   * granting authority the rails cannot honour, so the mandate is not permitted
   * to promise it.
   */
  capture_window_hours: z.number().int().min(1).max(72),
  discount_budget_inr_per_day: Rupees,
  per_buyer_discount_cap_inr: Rupees,
});

export const ConfidencePolicySchema = z.object({
  min_margin_confidence: Unit,
  below_threshold_discount_depth_pct: Pct,
});

export const COLLAPSE_ACTIONS = [
  'depth_pct=0',
  'log_incident',
  'notify_human',
  'require_human_approval',
] as const;

export const PressurePolicySchema = z.object({
  /** Above this, discount authority drops to zero. */
  collapse_threshold: Unit,
  /** Above this, authority tightens but does not collapse. Defaults to half of collapse. */
  guard_threshold: Unit.optional(),
  on_collapse: z.array(z.enum(COLLAPSE_ACTIONS)).min(1),
});

export const MANDATE_VERSION = 'counterparty/selling-mandate/1' as const;

const MandateBodySchema = z.object({
  version: z.literal(MANDATE_VERSION),
  envelope_id: z.string().min(1),
  merchant_id: z.string().min(1),
  issued_at: IsoDateTime,
  expires_at: IsoDateTime,
  gate_key: GateKeySchema,
  authority: AuthoritySchema,
  confidence_policy: ConfidencePolicySchema,
  pressure_policy: PressurePolicySchema,
});

type MandateBody = z.infer<typeof MandateBodySchema>;

/**
 * Cross-field rules. Each one describes an envelope that would parse but could
 * never be satisfied, or could be satisfied in a way that contradicts another
 * clause.
 */
function checkCoherence(mandate: MandateBody, ctx: z.RefinementCtx): void {
  if (Date.parse(mandate.expires_at) <= Date.parse(mandate.issued_at)) {
    ctx.addIssue({
      code: 'custom',
      path: ['expires_at'],
      message: 'expires_at must be after issued_at',
    });
  }

  const { guard_threshold: guard, collapse_threshold: collapse } = mandate.pressure_policy;
  if (guard !== undefined && guard > collapse) {
    ctx.addIssue({
      code: 'custom',
      path: ['pressure_policy', 'guard_threshold'],
      message: `guard_threshold (${guard}) must not exceed collapse_threshold (${collapse})`,
    });
  }

  const lowConfidenceDepth = mandate.confidence_policy.below_threshold_discount_depth_pct;
  const maxDepth = mandate.authority.max_discount_depth_pct;
  if (lowConfidenceDepth > maxDepth) {
    ctx.addIssue({
      code: 'custom',
      path: ['confidence_policy', 'below_threshold_discount_depth_pct'],
      message:
        `below_threshold_discount_depth_pct (${lowConfidenceDepth}) exceeds ` +
        `max_discount_depth_pct (${maxDepth}) — low confidence would grant MORE authority, not less`,
    });
  }

  const refund = mandate.authority.refund_authority;
  if (!refund.partial && refund.full_above_inr > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['authority', 'refund_authority'],
      message:
        'partial refunds are disabled and full refunds are gated above a threshold, ' +
        'which leaves no refund the gate can ever authorize',
    });
  }
}

/** An unsigned envelope. Only useful as input to issuance. */
export const UnsignedMandateSchema = MandateBodySchema.superRefine(checkCoherence);

/** A merchant-signed envelope. This is the artifact the whole system rests on. */
export const SellingMandateSchema = MandateBodySchema.extend({
  signature: SignatureSchema,
}).superRefine((mandate, ctx) => {
  checkCoherence(mandate, ctx);
  if (mandate.signature.role !== 'merchant') {
    ctx.addIssue({
      code: 'custom',
      path: ['signature', 'role'],
      message: `a selling mandate must be signed by the merchant, not by a ${mandate.signature.role}`,
    });
  }
});

export type UnsignedMandate = z.infer<typeof UnsignedMandateSchema>;
export type SellingMandate = z.infer<typeof SellingMandateSchema>;
export type Authority = z.infer<typeof AuthoritySchema>;
export type ConfidencePolicy = z.infer<typeof ConfidencePolicySchema>;
export type PressurePolicy = z.infer<typeof PressurePolicySchema>;
export type CollapseAction = (typeof COLLAPSE_ACTIONS)[number];
export type MandateSignature = z.infer<typeof SignatureSchema>;

/**
 * Every clause path the gate is allowed to cite in a refusal.
 *
 * A closed set on purpose. A refusal citing a clause that does not exist in the
 * envelope is worse than no refusal at all — it is an unfalsifiable explanation,
 * which is the exact failure mode this design exists to prevent. Keeping the
 * union closed turns a typo into a compile error.
 */
export const CLAUSE_PATHS = [
  'authority.floor_margin_pct',
  'authority.max_discount_depth_pct',
  'authority.eligible_skus',
  'authority.excluded_skus',
  'authority.bundle_rules.max_items',
  'authority.bundle_rules.combined_depth_pct',
  'authority.refund_authority.partial',
  'authority.refund_authority.full_above_inr',
  'authority.refund_authority.requires_human_above_inr',
  'authority.capture_window_hours',
  'authority.discount_budget_inr_per_day',
  'authority.per_buyer_discount_cap_inr',
  'confidence_policy.min_margin_confidence',
  'pressure_policy.collapse_threshold',
  'pressure_policy.guard_threshold',
  'envelope.expires_at',
  'envelope.gate_key',
  'envelope.signature',
] as const;

export type ClausePath = (typeof CLAUSE_PATHS)[number];

/** The guard threshold, defaulted to half the collapse threshold when unset. */
export function guardThreshold(policy: PressurePolicy): number {
  return policy.guard_threshold ?? policy.collapse_threshold / 2;
}

/**
 * SKU pattern matching. A `*` matches any run of characters; everything else is
 * literal. Deliberately not a full glob — the envelope is a document a merchant
 * has to be able to read, and `SKU-CLEARANCE-*` should mean the obvious thing
 * without anyone needing to know regex.
 */
export function matchesSkuPattern(sku: string, pattern: string): boolean {
  const escaped = pattern
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(sku);
}

/** A SKU is sellable when some eligible pattern matches and no excluded one does. */
export function skuIsEligible(sku: string, authority: Authority): boolean {
  const included = authority.eligible_skus.some((pattern) => matchesSkuPattern(sku, pattern));
  const excluded = authority.excluded_skus.some((pattern) => matchesSkuPattern(sku, pattern));
  return included && !excluded;
}
