/**
 * The propose/bind separation, checked by the compiler.
 *
 * The `@ts-expect-error` directives below ARE the assertions. `pnpm typecheck`
 * fails if any of them stops being an error — TypeScript reports an unused
 * `@ts-expect-error` directive as an error in its own right. So if someone
 * widens `SignedOffer`, drops the brand, or loosens a rails signature to accept
 * a proposal, this file goes red without anyone having to remember to check.
 *
 * The runtime tests below cover the other half: a value that was forced past
 * the type system with a cast still fails signature verification.
 */

import { describe, expect, it } from 'vitest';
import { evaluateQuote } from '../../src/gate/evaluate';
import type { OfferBody, QuoteProposal, SignedOffer } from '../../src/gate/offer';
import { OFFER_VERSION } from '../../src/gate/offer';
import type { Signature } from '../../src/crypto/sign';
import { signPayload, verifySigned } from '../../src/crypto/sign';
import type { JsonObject } from '../../src/crypto/canonical';
import { generateKeyPair, publicKeyRef } from '../../src/crypto/keys';
import { contextWith, gateKey } from './fixtures';

const proposal: QuoteProposal = {
  kind: 'quote',
  buyerId: 'buyer_a',
  lines: [{ sku: 'SKU-KETTLE-1L', quantity: 1 }],
  requestedDepthPct: 10,
  rationale: 'closing today',
};

const body: OfferBody = {
  version: OFFER_VERSION,
  offer_id: 'off_forged',
  envelope_id: 'env_test',
  merchant_id: 'acc_TEST0001',
  buyer_id: 'buyer_a',
  currency: 'INR',
  lines: [{ sku: 'SKU-KETTLE-1L', quantity: 1, list_unit_price_inr: 4990, offered_unit_price_inr: 499 }],
  list_total_inr: 4990,
  offered_total_inr: 499,
  depth_pct: 90,
  issued_at: '2026-08-25T09:00:00.000Z',
  expires_at: '2026-08-25T09:15:00.000Z',
  settlement_path: 'pre_auth',
  authorized_by: 'authority.max_discount_depth_pct',
  reservation_id: 'off_forged',
  pressure_score: 0,
};

/** A stand-in for a function that moves money: it accepts nothing but a SignedOffer. */
function executeOnRails(offer: SignedOffer): string {
  return offer.offer_id;
}

describe('only the gate can mint a SignedOffer', () => {
  it('rejects a bare offer body', () => {
    // @ts-expect-error a body with no signature is not a SignedOffer
    const forged: SignedOffer = body;
    expect(forged).toBeDefined();
  });

  it('rejects a body with a real signature bolted on', () => {
    const signed = signPayload(body as unknown as JsonObject, gateKey);
    // @ts-expect-error a valid signature is still not the gate's brand — the
    // brand key is a unique symbol this module has no way to name
    const forged: SignedOffer = signed as OfferBody & { signature: Signature };
    expect(forged).toBeDefined();
  });

  it('rejects a proposal where an offer is required', () => {
    // @ts-expect-error the model's output cannot reach a money-moving function
    executeOnRails(proposal);
  });

  it('rejects a plain object shaped like an offer', () => {
    // @ts-expect-error structural similarity is not enough
    executeOnRails({ ...body, signature: { alg: 'Ed25519', kid: 'x', role: 'gate', sig: 'x', signed_at: 'x' } });
  });

  it('accepts what the gate actually produced', () => {
    const decision = evaluateQuote(proposal, contextWith());
    if (!decision.ok) throw new Error(decision.refusal.reason);
    expect(executeOnRails(decision.offer)).toBe(decision.offer.offer_id);
  });
});

describe('and a forced cast still fails verification', () => {
  /**
   * The honest limit of the type-level guarantee: TypeScript cannot stop
   * `as unknown as SignedOffer`. It can only make the bypass explicit and
   * greppable. Signature verification is what catches it, which is why the rails
   * adapter verifies rather than trusting the type.
   */
  it('catches an unsigned body forced through a cast', () => {
    const forged = body as unknown as SignedOffer;
    expect(verifySigned(forged as unknown as JsonObject, publicKeyRef(gateKey)).ok).toBe(false);
  });

  it('catches a body signed by a key the envelope never delegated to', () => {
    const impostorGate = generateKeyPair('gate');
    const signed = signPayload(body as unknown as JsonObject, impostorGate);
    const result = verifySigned(signed, publicKeyRef(gateKey));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('key_mismatch');
  });

  it('catches a price edited after the gate signed it', () => {
    const decision = evaluateQuote(proposal, contextWith());
    if (!decision.ok) throw new Error(decision.refusal.reason);

    const tampered = { ...(decision.offer as unknown as JsonObject), offered_total_inr: 499 };
    expect(verifySigned(tampered, publicKeyRef(gateKey)).ok).toBe(false);
  });
});
