import { describe, expect, it } from 'vitest';
import { generateKeyPair, publicKeyRef } from '../../src/crypto/keys.js';
import type { JsonObject } from '../../src/crypto/canonical.js';
import { draftMandate } from '../../src/mandate/draft.js';
import { MandateError, issueMandate, limitsOf, verifyMandate } from '../../src/mandate/issue.js';
import { matchesSkuPattern, skuIsEligible } from '../../src/mandate/schema.js';

const merchantKey = generateKeyPair('merchant');
const gateKey = generateKeyPair('gate');
const gateRef = publicKeyRef(gateKey);
const merchantRef = publicKeyRef(merchantKey);

const baseInput = { merchantId: 'acc_TEST0001', gateKey: gateRef };

describe('issueMandate', () => {
  it('signs a coherent envelope', () => {
    const mandate = issueMandate(draftMandate(baseInput), merchantKey);
    expect(mandate.signature.role).toBe('merchant');
    expect(mandate.signature.kid).toBe(merchantKey.kid);
    expect(mandate.authority.max_discount_depth_pct).toBe(15);
  });

  it('names the gate key it delegates to', () => {
    const mandate = issueMandate(draftMandate(baseInput), merchantKey);
    expect(mandate.gate_key.kid).toBe(gateKey.kid);
    expect(mandate.gate_key.public_key_pem).toBe(gateKey.publicKeyPem);
  });

  it('refuses to be signed by a gate key', () => {
    expect(() => issueMandate(draftMandate(baseInput), gateKey)).toThrow(/must be signed by a merchant key/);
  });

  /**
   * If the merchant key and the gate key were the same, the separation between
   * granting authority and exercising it would be decorative.
   */
  it('refuses to delegate to the merchant key itself', () => {
    const selfDelegating = draftMandate({
      ...baseInput,
      gateKey: { ...merchantRef, role: 'gate' as const },
    });
    expect(() => issueMandate(selfDelegating, merchantKey)).toThrow(/must be separate keys/);
  });

  it('refuses a capture window longer than Razorpay will honour', () => {
    const tooLong = draftMandate({ ...baseInput, authority: { capture_window_hours: 96 } });
    expect(() => issueMandate(tooLong, merchantKey)).toThrow(MandateError);
  });

  it('refuses an envelope where low confidence grants more authority than high', () => {
    const inverted = draftMandate({
      ...baseInput,
      authority: { max_discount_depth_pct: 10 },
      confidencePolicy: { below_threshold_discount_depth_pct: 25 },
    });
    expect(() => issueMandate(inverted, merchantKey)).toThrow(/would grant MORE authority/);
  });

  it('refuses a guard threshold above the collapse threshold', () => {
    const inverted = draftMandate({
      ...baseInput,
      pressurePolicy: { collapse_threshold: 0.5, guard_threshold: 0.9 },
    });
    expect(() => issueMandate(inverted, merchantKey)).toThrow(/must not exceed collapse_threshold/);
  });

  it('refuses a refund policy that authorizes no refund at all', () => {
    const unusable = draftMandate({
      ...baseInput,
      authority: { refund_authority: { partial: false, full_above_inr: 5000, requires_human_above_inr: 5000 } },
    });
    expect(() => issueMandate(unusable, merchantKey)).toThrow(/no refund the gate can ever authorize/);
  });
});

describe('verifyMandate', () => {
  it('accepts a freshly issued mandate', () => {
    const mandate = issueMandate(draftMandate(baseInput), merchantKey);
    const result = verifyMandate(mandate, merchantRef);
    expect(result.ok).toBe(true);
  });

  it('rejects a tampered discount ceiling', () => {
    const mandate = issueMandate(draftMandate(baseInput), merchantKey) as JsonObject;
    const tampered = {
      ...mandate,
      authority: { ...(mandate['authority'] as JsonObject), max_discount_depth_pct: 90 },
    };
    const result = verifyMandate(tampered, merchantRef);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature');
  });

  it('rejects a mandate signed by someone else', () => {
    const impostor = generateKeyPair('merchant');
    const mandate = issueMandate(draftMandate(baseInput), impostor);
    const result = verifyMandate(mandate, merchantRef);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'signature') {
      expect(result.failure).toBe('key_mismatch');
    } else {
      expect.unreachable('expected a signature failure');
    }
  });

  it('rejects an expired mandate even though the signature is good', () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const mandate = issueMandate(draftMandate({ ...baseInput, issuedAt, validForDays: 30 }), merchantKey, issuedAt);
    const result = verifyMandate(mandate, merchantRef, new Date('2026-06-01T00:00:00Z'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects a mandate that is not yet valid', () => {
    const issuedAt = new Date('2026-12-01T00:00:00Z');
    const mandate = issueMandate(draftMandate({ ...baseInput, issuedAt }), merchantKey, issuedAt);
    const result = verifyMandate(mandate, merchantRef, new Date('2026-06-01T00:00:00Z'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_yet_valid');
  });

  it('rejects a document that is not a mandate at all', () => {
    const result = verifyMandate({ hello: 'world' }, merchantRef);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('schema');
  });

  it('distinguishes a schema failure from a signature failure', () => {
    const mandate = issueMandate(draftMandate(baseInput), merchantKey) as JsonObject;
    const { authority: _removed, ...gutted } = mandate;
    const result = verifyMandate(gutted, merchantRef);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('schema');
  });
});

describe('limitsOf', () => {
  it('converts every rupee clause to paise exactly once', () => {
    const mandate = issueMandate(draftMandate(baseInput), merchantKey);
    const limits = limitsOf(mandate);
    expect(limits.dailyDiscountBudget).toBe(4_000_000);
    expect(limits.perBuyerDiscountCap).toBe(200_000);
    expect(limits.refundRequiresHumanAbove).toBe(500_000);
  });

  it('converts the capture window to milliseconds', () => {
    const mandate = issueMandate(draftMandate(baseInput), merchantKey);
    expect(limitsOf(mandate).captureWindowMs).toBe(72 * 60 * 60 * 1000);
  });
});

describe('SKU patterns', () => {
  it('matches a trailing wildcard', () => {
    expect(matchesSkuPattern('SKU-KETTLE-1L', 'SKU-*')).toBe(true);
    expect(matchesSkuPattern('OTHER-KETTLE', 'SKU-*')).toBe(false);
  });

  it('treats dots and dashes as literals, not regex', () => {
    expect(matchesSkuPattern('SKU-A.B', 'SKU-A.B')).toBe(true);
    expect(matchesSkuPattern('SKU-AXB', 'SKU-A.B')).toBe(false);
  });

  it('handles a pattern containing a space', () => {
    expect(matchesSkuPattern('KIT SET 3', 'KIT SET *')).toBe(true);
    expect(matchesSkuPattern('KITSET3', 'KIT SET *')).toBe(false);
  });

  it('excludes clearance stock even though the include pattern matches', () => {
    const mandate = issueMandate(draftMandate(baseInput), merchantKey);
    expect(skuIsEligible('SKU-KETTLE-1L', mandate.authority)).toBe(true);
    expect(skuIsEligible('SKU-CLEARANCE-KETTLE', mandate.authority)).toBe(false);
  });
});
