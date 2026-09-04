/**
 * The counterparty check, from the buyer's side of the table.
 *
 * Every test here holds only what a buyer would hold: the offer as JSON, the
 * envelope as JSON, and the merchant's public key. No private keys, no gate
 * internals, no access to the seller's process. If a test needs anything else to
 * pass, the verifier is not doing what it claims.
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPair, publicKeyRef } from '../../src/crypto/keys';
import { signPayload, type Signed } from '../../src/crypto/sign';
import type { JsonObject } from '../../src/crypto/canonical';
import { evaluateQuote } from '../../src/gate/evaluate';
import { OFFER_VERSION, type OfferBody, type QuoteProposal } from '../../src/gate/offer';
import { verifyAsCounterparty, formatVerdict, COUNTERPARTY_CHECKS } from '../../src/counterparty/verify';
import { NOW, contextWith, gateKey, mandateWith, merchantKey } from '../gate/fixtures';

const merchantRef = publicKeyRef(merchantKey);

/** A real offer, produced by the real gate — the only honest starting point. */
function signedOffer(overrides: Partial<QuoteProposal> = {}): JsonObject {
  const decision = evaluateQuote(
    {
      kind: 'quote',
      buyerId: 'buyer_a',
      lines: [{ sku: 'SKU-KETTLE-1L', quantity: 1 }],
      requestedDepthPct: 10,
      rationale: 'a small concession to close today',
      ...overrides,
    },
    contextWith(),
  );
  if (!decision.ok) throw new Error(`fixture did not sign: ${decision.refusal.reason}`);
  return JSON.parse(JSON.stringify(decision.offer)) as JsonObject;
}

function envelopeJson(mandate = mandateWith()): JsonObject {
  return JSON.parse(JSON.stringify(mandate)) as JsonObject;
}

function check(offer: JsonObject, envelope: JsonObject = envelopeJson(), now: Date = NOW) {
  return verifyAsCounterparty({ offer, envelope, merchantPublicKey: merchantRef, now });
}

/**
 * Build an offer by hand and sign it with a real gate key. Used for the attacks
 * that need a *valid* signature over an *invalid* offer — the interesting half.
 */
function forge(body: Partial<OfferBody>, key = gateKey): JsonObject {
  const full: OfferBody = {
    version: OFFER_VERSION,
    offer_id: 'off_forged',
    envelope_id: 'env_test',
    merchant_id: 'acc_TEST0001',
    buyer_id: 'buyer_a',
    currency: 'INR',
    lines: [
      { sku: 'SKU-KETTLE-1L', quantity: 1, list_unit_price_inr: 4990, offered_unit_price_inr: 4491 },
    ],
    list_total_inr: 4990,
    offered_total_inr: 4491,
    depth_pct: 10,
    issued_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
    settlement_path: 'pre_auth',
    authorized_by: 'authority.max_discount_depth_pct',
    reservation_id: 'rsv_forged',
    pressure_score: 0,
    ...body,
  };
  const signed: Signed<JsonObject> = signPayload(full as unknown as JsonObject, key, NOW);
  return JSON.parse(JSON.stringify(signed)) as JsonObject;
}

describe('an offer the merchant genuinely authorized', () => {
  it('is accepted', () => {
    const verdict = check(signedOffer());
    expect(verdict.ok).toBe(true);
  });

  it('runs every check in the chain', () => {
    const verdict = check(signedOffer());
    expect(verdict.checks.map((c) => c.check)).toEqual([...COUNTERPARTY_CHECKS]);
    expect(verdict.checks.every((c) => c.ok)).toBe(true);
  });

  it('reports the terms from the verified envelope, not from the offer', () => {
    const verdict = check(signedOffer());
    if (!verdict.ok) throw new Error(verdict.detail);
    expect(verdict.merchantId).toBe('acc_TEST0001');
    expect(verdict.envelopeId).toBe('env_test');
    expect(verdict.depthPct).toBe(10);
    expect(verdict.maxDepthPct).toBe(15);
  });

  it('needs nothing but public inputs', () => {
    // The merchant reference carries a public key and no private material.
    expect(JSON.stringify(merchantRef)).not.toContain('PRIVATE');
    expect(check(signedOffer()).ok).toBe(true);
  });
});

describe('the offer was edited after signing', () => {
  it('rejects a single rupee moved', () => {
    const offer = signedOffer();
    offer['offered_total_inr'] = (offer['offered_total_inr'] as number) - 1;
    const verdict = check(offer);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('offer_signature');
  });

  it('rejects a rewritten buyer id', () => {
    const offer = signedOffer();
    offer['buyer_id'] = 'buyer_someone_else';
    const verdict = check(offer);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('offer_signature');
  });

  it('rejects an offer with the signature stripped off entirely', () => {
    const offer = signedOffer();
    delete offer['signature'];
    const verdict = check(offer);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // No signature means no kid, so it cannot even be read as an offer.
    expect(verdict.failed).toBe('offer_wellformed');
  });
});

describe('the envelope was edited after issuing', () => {
  it('rejects an envelope whose depth ceiling was widened', () => {
    const envelope = envelopeJson();
    const authority = envelope['authority'] as Record<string, unknown>;
    authority['max_discount_depth_pct'] = 90;

    const verdict = check(signedOffer(), envelope);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('envelope_signature');
  });

  it('rejects an envelope pointed at a different gate key', () => {
    const attacker = generateKeyPair('gate');
    const envelope = envelopeJson();
    (envelope['gate_key'] as Record<string, unknown>)['kid'] = attacker.kid;

    const verdict = check(signedOffer(), envelope);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('envelope_signature');
  });

  it('rejects an envelope signed by someone other than the merchant', () => {
    const impostor = generateKeyPair('merchant');
    const envelope = envelopeJson(mandateWith());
    const restated = signPayload(
      JSON.parse(JSON.stringify({ ...envelope, signature: undefined })) as JsonObject,
      impostor,
      NOW,
    );
    const verdict = check(signedOffer(), JSON.parse(JSON.stringify(restated)) as JsonObject);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('envelope_signature');
    expect(verdict.detail).toContain('key_mismatch');
  });
});

/**
 * The link that makes a signature mean something.
 *
 * Each of these offers carries a signature that verifies perfectly — against a
 * key this merchant never delegated to. A verifier that checked only "is this
 * signed?" would accept all of them.
 */
describe('the offer was signed by a gate the envelope never delegated to', () => {
  it('rejects an offer from an undelegated gate, however well signed', () => {
    const rogue = generateKeyPair('gate');
    const offer = forge({ offer_id: 'off_rogue' }, rogue);

    const verdict = check(offer);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('gate_is_delegated');
    expect(verdict.detail).toContain('delegated only to');
  });

  it('does not reach the signature check, because the answer would be misleading', () => {
    const rogue = generateKeyPair('gate');
    const verdict = check(forge({}, rogue));
    expect(verdict.checks.some((c) => c.check === 'offer_signature')).toBe(false);
  });
});

describe('the offer does not belong to this envelope', () => {
  it('rejects an offer citing a different envelope id', () => {
    const verdict = check(forge({ envelope_id: 'env_somewhere_else' }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('offer_names_envelope');
  });

  it('rejects an offer from a different merchant', () => {
    const verdict = check(forge({ merchant_id: 'acc_OTHER' }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('offer_names_envelope');
  });
});

describe('validity windows', () => {
  it('rejects an offer verified after the envelope expired', () => {
    const wayLater = new Date(Date.parse(mandateWith().expires_at) + 1000);
    const verdict = check(signedOffer(), envelopeJson(), wayLater);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('envelope_in_force');
  });

  it('rejects an expired offer under a still-valid envelope', () => {
    const offer = signedOffer();
    const anHourOn = new Date(Date.parse(offer['expires_at'] as string) + 1000);
    const verdict = check(offer, envelopeJson(), anHourOn);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('offer_unexpired');
  });
});

/**
 * Signed nonsense is still nonsense. These offers are correctly signed by the
 * correct gate under the correct envelope, and are still not offers.
 */
describe('the offer disagrees with itself', () => {
  it('rejects a depth that does not follow from the totals', () => {
    // Totals say 40% off. `depth_pct` says 10, so a verifier reading only the
    // stated depth would wave through a 40% discount.
    const verdict = check(
      forge({
        lines: [
          { sku: 'SKU-KETTLE-1L', quantity: 1, list_unit_price_inr: 4990, offered_unit_price_inr: 2994 },
        ],
        list_total_inr: 4990,
        offered_total_inr: 2994,
        depth_pct: 10,
      }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('arithmetic_consistent');
    expect(verdict.detail).toContain('40.00%');
  });

  it('rejects totals that do not match the lines', () => {
    const verdict = check(forge({ offered_total_inr: 100 }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('arithmetic_consistent');
  });

  it('rejects an offer priced above list', () => {
    const verdict = check(
      forge({
        lines: [
          { sku: 'SKU-KETTLE-1L', quantity: 1, list_unit_price_inr: 4990, offered_unit_price_inr: 6000 },
        ],
        list_total_inr: 4990,
        offered_total_inr: 6000,
        depth_pct: -20.24,
      }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('arithmetic_consistent');
  });
});

/**
 * The check no merchant-side code can perform on the buyer's behalf: whether the
 * merchant's own agent stayed inside the merchant's own published limits.
 */
describe('the offer exceeds what the merchant published', () => {
  it('rejects a depth beyond the published ceiling, correctly signed', () => {
    const offer = forge({
      lines: [
        { sku: 'SKU-KETTLE-1L', quantity: 1, list_unit_price_inr: 4990, offered_unit_price_inr: 2994 },
      ],
      list_total_inr: 4990,
      offered_total_inr: 2994,
      depth_pct: 40,
    });

    // It is genuinely signed by the genuinely delegated gate.
    const verdict = check(offer);
    expect(verdict.checks.find((c) => c.check === 'offer_signature')?.ok).toBe(true);
    expect(verdict.checks.find((c) => c.check === 'gate_is_delegated')?.ok).toBe(true);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('within_published_authority');
    expect(verdict.detail).toContain('exceeding the published');
  });

  it('rejects an excluded SKU', () => {
    const verdict = check(
      forge({
        lines: [
          {
            sku: 'SKU-CLEARANCE-KETTLE',
            quantity: 1,
            list_unit_price_inr: 4990,
            offered_unit_price_inr: 4491,
          },
        ],
      }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('within_published_authority');
    expect(verdict.detail).toContain('not sellable');
  });

  it('rejects more units than the bundle rules allow', () => {
    const verdict = check(
      forge({
        lines: [
          { sku: 'SKU-KETTLE-1L', quantity: 9, list_unit_price_inr: 4990, offered_unit_price_inr: 4491 },
        ],
        list_total_inr: 44910,
        offered_total_inr: 40419,
        depth_pct: 10,
      }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('within_published_authority');
    expect(verdict.detail).toContain('max_items');
  });

  it('applies the bundle ceiling, not the single-item one, to a bundle', () => {
    // 18% off two units: over the 15% single-item cap, under the 20% bundle cap,
    // and ₹1,796 of discount — inside the ₹2,000 per-buyer cap as well.
    const verdict = check(
      forge({
        lines: [
          { sku: 'SKU-KETTLE-1L', quantity: 2, list_unit_price_inr: 4990, offered_unit_price_inr: 4091.8 },
        ],
        list_total_inr: 9980,
        offered_total_inr: 8183.6,
        depth_pct: 18,
      }),
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.maxDepthPct).toBe(20);
  });

  /**
   * The clause that binds in rupees rather than percent. A depth inside the
   * bundle ceiling can still hand over more money than the envelope permits any
   * single buyer to receive, and the percentage alone will never say so.
   */
  it('rejects a discount over the per-buyer rupee cap even at a permitted depth', () => {
    const verdict = check(
      forge({
        lines: [
          { sku: 'SKU-KETTLE-1L', quantity: 3, list_unit_price_inr: 4990, offered_unit_price_inr: 4091.8 },
        ],
        list_total_inr: 14970,
        offered_total_inr: 12275.4,
        depth_pct: 18,
      }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toBe('within_published_authority');
    expect(verdict.detail).toContain('per_buyer_discount_cap_inr');
  });
});

describe('the report', () => {
  it('shows a passing chain', () => {
    const text = formatVerdict(check(signedOffer()));
    expect(text).toContain('ACCEPTED');
    expect(text).not.toContain('not reached');
  });

  it('shows which check failed and marks the rest as never run', () => {
    const rogue = generateKeyPair('gate');
    const text = formatVerdict(check(forge({}, rogue)));
    expect(text).toContain('REJECTED  gate_is_delegated');
    expect(text).toContain('offer_signature');
    expect(text).toContain('not reached');
  });
});
