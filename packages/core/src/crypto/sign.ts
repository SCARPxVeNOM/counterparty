/**
 * Detached Ed25519 signatures over canonical JSON.
 *
 * The signature travels inside the document it signs, which creates the obvious
 * trap: signing a document that already contains its own signature field, or
 * verifying one without removing it first. Both produce silent, total failure —
 * signatures that never verify, or worse, a verifier that appears to work
 * because it is comparing two equally wrong things.
 *
 * So the only public way to sign here attaches the signature itself, and the
 * only public way to verify strips it. Callers never handle the split.
 */

import { sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { canonicalBytes, type JsonObject } from './canonical.js';
import {
  toPrivateKeyObject,
  toPublicKeyObject,
  type KeyPair,
  type KeyRole,
  type PublicKeyRef,
} from './keys.js';

export type Signature = {
  readonly alg: 'Ed25519';
  readonly kid: string;
  readonly role: KeyRole;
  /** base64url, unpadded. */
  readonly sig: string;
  readonly signed_at: string;
};

export type Signed<T extends JsonObject> = T & { readonly signature: Signature };

export type VerifyFailure =
  | 'missing_signature'
  | 'unsupported_algorithm'
  | 'key_mismatch'
  | 'role_mismatch'
  | 'malformed_signature'
  | 'bad_signature';

export type VerifyResult =
  | { readonly ok: true; readonly kid: string; readonly role: KeyRole; readonly signed_at: string }
  | { readonly ok: false; readonly reason: VerifyFailure; readonly detail: string };

/**
 * Sign `payload` and return it with a `signature` member attached.
 *
 * `signed_at` is inside the signed bytes, so it cannot be back-dated after the
 * fact without invalidating the signature.
 */
export function signPayload<T extends JsonObject>(
  payload: T,
  keyPair: KeyPair,
  signedAt: Date = new Date(),
): Signed<T> {
  if ('signature' in payload && payload['signature'] !== undefined) {
    throw new Error('payload already carries a signature; sign the unsigned payload');
  }

  const signature: Omit<Signature, 'sig'> = {
    alg: 'Ed25519',
    kid: keyPair.kid,
    role: keyPair.role,
    signed_at: signedAt.toISOString(),
  };

  // The signature metadata is inside the signed bytes — the algorithm, the key
  // id, the role and the timestamp are all bound to the document. Only `sig`
  // itself is excluded, because it cannot sign itself.
  const bytes = canonicalBytes({ ...payload, signature } as JsonObject);
  const sig = nodeSign(null, bytes, toPrivateKeyObject(keyPair.privateKeyPem));

  return {
    ...payload,
    signature: { ...signature, sig: toBase64Url(sig) },
  } as Signed<T>;
}

/**
 * Verify a signed document against an expected public key.
 *
 * Returns a reason rather than throwing, because "why did this fail" is the
 * interesting output — the CLI prints it, and a buyer agent needs to
 * distinguish "wrong key" from "tampered document".
 */
export function verifySigned(
  document: JsonObject,
  expected: PublicKeyRef,
): VerifyResult {
  const signature = document['signature'];

  if (signature === undefined || signature === null || typeof signature !== 'object' || Array.isArray(signature)) {
    return { ok: false, reason: 'missing_signature', detail: 'document has no signature member' };
  }

  const { alg, kid, role, sig, signed_at: signedAt } = signature as Record<string, unknown>;

  if (alg !== 'Ed25519') {
    return { ok: false, reason: 'unsupported_algorithm', detail: `expected Ed25519, got ${String(alg)}` };
  }
  if (typeof kid !== 'string' || typeof sig !== 'string' || typeof signedAt !== 'string') {
    return { ok: false, reason: 'malformed_signature', detail: 'kid, sig and signed_at must all be strings' };
  }
  if (kid !== expected.kid) {
    return {
      ok: false,
      reason: 'key_mismatch',
      detail: `document was signed by key ${kid}, but was verified against ${expected.kid}`,
    };
  }
  if (role !== expected.role) {
    return {
      ok: false,
      reason: 'role_mismatch',
      detail: `document claims role ${String(role)}, but the key presented is a ${expected.role} key`,
    };
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64Url(sig);
  } catch (cause) {
    return { ok: false, reason: 'malformed_signature', detail: (cause as Error).message };
  }
  if (signatureBytes.length !== 64) {
    return {
      ok: false,
      reason: 'malformed_signature',
      detail: `an Ed25519 signature is 64 bytes, got ${signatureBytes.length}`,
    };
  }

  // Reconstruct exactly what was signed: the document with `sig` removed from
  // the signature member, everything else intact.
  const { sig: _omitted, ...signatureWithoutSig } = signature as Record<string, unknown>;
  const payload = { ...document, signature: signatureWithoutSig } as JsonObject;

  let valid: boolean;
  try {
    valid = nodeVerify(null, canonicalBytes(payload), toPublicKeyObject(expected.publicKeyPem), signatureBytes);
  } catch (cause) {
    return { ok: false, reason: 'bad_signature', detail: (cause as Error).message };
  }

  if (!valid) {
    return {
      ok: false,
      reason: 'bad_signature',
      detail: 'signature does not match the document — it was modified after signing, or signed by a different key',
    };
  }

  return { ok: true, kid, role: role as KeyRole, signed_at: signedAt };
}

/** Remove the signature member — useful for re-signing or for display. */
export function stripSignature<T extends JsonObject>(document: Signed<T> | T): T {
  const { signature: _dropped, ...rest } = document as JsonObject;
  return rest as T;
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error('signature is not valid base64url');
  }
  return new Uint8Array(Buffer.from(value, 'base64url'));
}
