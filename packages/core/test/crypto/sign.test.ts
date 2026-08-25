import { describe, expect, it } from 'vitest';
import {
  generateKeyPair,
  kidFromPublicKeyPem,
  loadKeyPair,
  publicKeyRef,
  rawPublicKey,
} from '../../src/crypto/keys.js';
import { signPayload, stripSignature, verifySigned } from '../../src/crypto/sign.js';
import type { JsonObject } from '../../src/crypto/canonical.js';

const merchant = generateKeyPair('merchant');
const gate = generateKeyPair('gate');

const offer: JsonObject = {
  offer_id: 'off_001',
  sku: 'SKU-KETTLE-1L',
  list_price_inr: 4990,
  offered_price_inr: 4240,
  depth_pct: 15,
};

describe('keys', () => {
  it('derives a stable 16-char key id from the public key', () => {
    expect(merchant.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(kidFromPublicKeyPem(merchant.publicKeyPem)).toBe(merchant.kid);
  });

  it('gives different key pairs different ids', () => {
    expect(merchant.kid).not.toBe(gate.kid);
  });

  it('round-trips through the private key alone', () => {
    const reloaded = loadKeyPair('merchant', merchant.privateKeyPem);
    expect(reloaded.kid).toBe(merchant.kid);
    expect(reloaded.publicKeyPem).toBe(merchant.publicKeyPem);
  });

  it('unwraps exactly 32 raw public key bytes', () => {
    expect(rawPublicKey(merchant.publicKeyPem)).toHaveLength(32);
  });

  it('exposes no private half in a public key ref', () => {
    const ref = publicKeyRef(merchant) as unknown as Record<string, unknown>;
    expect(ref['privateKeyPem']).toBeUndefined();
    expect(JSON.stringify(ref)).not.toContain('PRIVATE');
  });
});

describe('signPayload / verifySigned', () => {
  it('round-trips', () => {
    const signed = signPayload(offer, gate);
    const result = verifySigned(signed, publicKeyRef(gate));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kid).toBe(gate.kid);
      expect(result.role).toBe('gate');
    }
  });

  it('binds the algorithm, key id, role and timestamp into the signed bytes', () => {
    const signed = signPayload(offer, gate);
    expect(signed.signature.alg).toBe('Ed25519');
    expect(signed.signature.kid).toBe(gate.kid);
    expect(signed.signature.role).toBe('gate');
    expect(signed.signature.signed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('verifies regardless of how the document members are ordered', () => {
    const signed = signPayload(offer, gate);
    const reordered: JsonObject = {
      signature: signed.signature,
      depth_pct: signed.depth_pct,
      offered_price_inr: signed.offered_price_inr,
      list_price_inr: signed.list_price_inr,
      sku: signed.sku,
      offer_id: signed.offer_id,
    };
    expect(verifySigned(reordered, publicKeyRef(gate)).ok).toBe(true);
  });

  it('refuses to sign a document that already carries a signature', () => {
    const signed = signPayload(offer, gate);
    expect(() => signPayload(signed as JsonObject, gate)).toThrow(/already carries a signature/);
  });

  it('strips the signature back off', () => {
    const signed = signPayload(offer, gate);
    expect(stripSignature(signed)).toEqual(offer);
  });
});

describe('verifySigned — tamper detection', () => {
  it('rejects a changed price', () => {
    const signed = signPayload(offer, gate) as JsonObject;
    const tampered = { ...signed, offered_price_inr: 499 };
    const result = verifySigned(tampered, publicKeyRef(gate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a one-rupee change — the demo case', () => {
    const signed = signPayload(offer, gate) as JsonObject;
    const tampered = { ...signed, offered_price_inr: 4239 };
    expect(verifySigned(tampered, publicKeyRef(gate)).ok).toBe(false);
  });

  it('rejects an added member', () => {
    const signed = signPayload(offer, gate) as JsonObject;
    const tampered = { ...signed, free_shipping: true };
    expect(verifySigned(tampered, publicKeyRef(gate)).ok).toBe(false);
  });

  it('rejects a removed member', () => {
    const signed = signPayload(offer, gate) as JsonObject;
    const { depth_pct: _dropped, ...tampered } = signed;
    expect(verifySigned(tampered, publicKeyRef(gate)).ok).toBe(false);
  });

  it('rejects a back-dated signature timestamp', () => {
    const signed = signPayload(offer, gate);
    const tampered: JsonObject = {
      ...signed,
      signature: { ...signed.signature, signed_at: '2020-01-01T00:00:00.000Z' },
    };
    expect(verifySigned(tampered, publicKeyRef(gate)).ok).toBe(false);
  });

  it('rejects a corrupted signature', () => {
    const signed = signPayload(offer, gate);
    const flipped = signed.signature.sig.startsWith('A')
      ? `B${signed.signature.sig.slice(1)}`
      : `A${signed.signature.sig.slice(1)}`;
    const tampered: JsonObject = { ...signed, signature: { ...signed.signature, sig: flipped } };
    expect(verifySigned(tampered, publicKeyRef(gate)).ok).toBe(false);
  });
});

describe('verifySigned — failure reasons', () => {
  it('reports a missing signature', () => {
    const result = verifySigned(offer, publicKeyRef(gate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_signature');
  });

  it('reports a key mismatch when verified against the wrong key', () => {
    const signed = signPayload(offer, gate);
    const result = verifySigned(signed, publicKeyRef(merchant));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('key_mismatch');
      expect(result.detail).toContain(gate.kid);
    }
  });

  it('reports a role mismatch when a gate offer is checked against a merchant role', () => {
    const signed = signPayload(offer, gate);
    const spoofed = { ...publicKeyRef(gate), role: 'merchant' as const };
    const result = verifySigned(signed, spoofed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('role_mismatch');
  });

  it('reports an unsupported algorithm', () => {
    const signed = signPayload(offer, gate);
    const tampered: JsonObject = { ...signed, signature: { ...signed.signature, alg: 'none' } };
    const result = verifySigned(tampered, publicKeyRef(gate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_algorithm');
  });

  it('reports a malformed signature encoding', () => {
    const signed = signPayload(offer, gate);
    const tampered: JsonObject = { ...signed, signature: { ...signed.signature, sig: 'not base64url!!' } };
    const result = verifySigned(tampered, publicKeyRef(gate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed_signature');
  });

  it('reports a wrong-length signature', () => {
    const signed = signPayload(offer, gate);
    const tampered: JsonObject = { ...signed, signature: { ...signed.signature, sig: 'AAAA' } };
    const result = verifySigned(tampered, publicKeyRef(gate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('64 bytes');
  });
});
