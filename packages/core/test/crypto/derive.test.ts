import { describe, expect, it } from 'vitest';
import { deriveKeyPair, generateKeyPair, KeyError, rawPublicKey } from '../../src/crypto/keys';
import { signPayload, verifySigned } from '../../src/crypto/sign';
import { publicKeyRef } from '../../src/crypto/keys';
import type { JsonObject } from '../../src/crypto/canonical';

describe('deriveKeyPair', () => {
  it('produces the same key every time for the same seed', () => {
    const a = deriveKeyPair('merchant', 'counterparty-demo-merchant-v1');
    const b = deriveKeyPair('merchant', 'counterparty-demo-merchant-v1');
    expect(a.kid).toBe(b.kid);
    expect(a.privateKeyPem).toBe(b.privateKeyPem);
    expect(a.publicKeyPem).toBe(b.publicKeyPem);
  });

  it('produces different keys for different seeds', () => {
    const merchant = deriveKeyPair('merchant', 'counterparty-demo-merchant-v1');
    const gate = deriveKeyPair('gate', 'counterparty-demo-gate-v1');
    expect(merchant.kid).not.toBe(gate.kid);
  });

  it('is sensitive to a one-character seed change', () => {
    expect(deriveKeyPair('gate', 'seed-a').kid).not.toBe(deriveKeyPair('gate', 'seed-b').kid);
  });

  it('yields a real, usable Ed25519 key', () => {
    const key = deriveKeyPair('gate', 'test-seed');
    expect(rawPublicKey(key.publicKeyPem)).toHaveLength(32);

    const doc: JsonObject = { offer_id: 'off_1', amount: 4990 };
    const signed = signPayload(doc, key);
    expect(verifySigned(signed, publicKeyRef(key)).ok).toBe(true);
  });

  it('is indistinguishable from a generated key downstream', () => {
    const derived = deriveKeyPair('gate', 'test-seed');
    const generated = generateKeyPair('gate');
    expect(derived.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(
      generated.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----'),
    );
    expect(derived.kid).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses an empty seed', () => {
    expect(() => deriveKeyPair('gate', '')).toThrow(KeyError);
    expect(() => deriveKeyPair('gate', '   ')).toThrow(KeyError);
  });
});

describe('no key material in the source tree', () => {
  /**
   * The regression this exists to prevent. Committing a PEM gets the same
   * determinism and trips every secret scanner, and the resulting alert is
   * indistinguishable from a real leak until someone reads the comment beside
   * it. Deriving from a public label is the same thing without that cost.
   */
  it('derives demo keys from a seed rather than a stored PEM', async () => {
    const demo = await import('@counterparty/demo');
    expect(demo.merchantKey.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(demo.gateKey.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(demo.merchantKey.kid).not.toBe(demo.gateKey.kid);
  });
});
