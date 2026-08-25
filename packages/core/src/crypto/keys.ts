/**
 * Ed25519 key material.
 *
 * Two distinct keys exist in this system and conflating them would collapse the
 * whole authority model:
 *
 *   merchant key — signs the selling mandate envelope. Represents the merchant's
 *                  grant of authority. Held by the merchant, ideally offline.
 *   gate key     — signs individual offers. Represents "the gate checked this
 *                  proposal against a valid envelope and it passed."
 *
 * A buyer verifying an offer checks the gate signature on the offer AND the
 * merchant signature on the envelope the offer cites. One without the other
 * proves nothing: a gate signature alone says a gate approved it, but not that
 * any merchant ever authorized that gate's limits.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';

export type KeyRole = 'merchant' | 'gate';

export interface KeyPair {
  readonly role: KeyRole;
  /** Stable short identifier derived from the public key. Appears in audit rows. */
  readonly kid: string;
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

/** What a verifier needs. Deliberately has no private half. */
export interface PublicKeyRef {
  readonly role: KeyRole;
  readonly kid: string;
  readonly publicKeyPem: string;
}

export class KeyError extends Error {
  override readonly name = 'KeyError';
}

export function generateKeyPair(role: KeyRole): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = exportPublicPem(publicKey);
  return {
    role,
    kid: kidFromPublicKeyPem(publicKeyPem),
    publicKeyPem,
    privateKeyPem: exportPrivatePem(privateKey),
  };
}

/** Rebuild a key pair from a stored PKCS#8 private key. */
export function loadKeyPair(role: KeyRole, privateKeyPem: string): KeyPair {
  const privateKey = toPrivateKeyObject(privateKeyPem);
  const publicKeyPem = exportPublicPem(createPublicKey(privateKey));
  return {
    role,
    kid: kidFromPublicKeyPem(publicKeyPem),
    publicKeyPem,
    privateKeyPem: exportPrivatePem(privateKey),
  };
}

export function publicKeyRef(keyPair: KeyPair): PublicKeyRef {
  return { role: keyPair.role, kid: keyPair.kid, publicKeyPem: keyPair.publicKeyPem };
}

/**
 * Key id = first 16 hex chars of SHA-256 over the raw 32-byte public key.
 *
 * Derived from the raw key rather than the PEM so that re-encoding the same key
 * — different line wrapping, trailing newline, DER vs PEM round trip — always
 * yields the same id.
 */
export function kidFromPublicKeyPem(publicKeyPem: string): string {
  const raw = rawPublicKey(publicKeyPem);
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** The 32 raw Ed25519 public key bytes, unwrapped from their SPKI envelope. */
export function rawPublicKey(publicKeyPem: string): Uint8Array {
  const der = toPublicKeyObject(publicKeyPem).export({ format: 'der', type: 'spki' });
  // An Ed25519 SPKI structure is a fixed 12-byte prefix followed by the key.
  if (der.length !== 44) {
    throw new KeyError(`expected a 44-byte Ed25519 SPKI structure, got ${der.length}`);
  }
  return new Uint8Array(der.subarray(12));
}

export function toPrivateKeyObject(privateKeyPem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch (cause) {
    throw new KeyError(`could not parse private key: ${(cause as Error).message}`);
  }
  assertEd25519(key);
  return key;
}

export function toPublicKeyObject(publicKeyPem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch (cause) {
    throw new KeyError(`could not parse public key: ${(cause as Error).message}`);
  }
  assertEd25519(key);
  return key;
}

function assertEd25519(key: KeyObject): void {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new KeyError(`expected an ed25519 key, got ${key.asymmetricKeyType ?? 'unknown'}`);
  }
}

function exportPublicPem(key: KeyObject): string {
  return key.export({ format: 'pem', type: 'spki' }).toString();
}

function exportPrivatePem(key: KeyObject): string {
  return key.export({ format: 'pem', type: 'pkcs8' }).toString();
}
