/**
 * The check the buyer's agent runs. The one this project is named for.
 *
 * Everything else in this repo is the merchant proving to itself that its own
 * agent stayed inside its own limits. That is worth doing — the rails refuse to
 * execute an offer whose gate signature does not verify — but it is a merchant
 * checking a key the merchant already trusts. It is not a counterparty check,
 * and until something here performs one, "the buyer agent can verify the
 * signature" is a property of the format rather than of the system.
 *
 * This module is that check, and it runs on the other side of the table.
 *
 * WHAT THE BUYER HAS
 *
 *   - the offer, as it came over the wire: plain JSON, no brand, untrusted
 *   - the envelope the offer claims to act under: also untrusted
 *   - the merchant's public key, obtained OUT OF BAND — from a key directory, a
 *     well-known URL, a prior relationship. Never from the offer, and never from
 *     the envelope.
 *
 * That last constraint is the whole trust model, which is why the signature
 * takes a `PublicKeyRef` and not a document to read one out of. A verifier that
 * accepts the key its input names verifies nothing at all: a forger supplies a
 * document, a key, and a signature that agree with each other perfectly.
 *
 * WHAT IT PROVES, IN ORDER
 *
 * The interesting link is the third one. A gate signature on its own says only
 * that *some* gate approved this price. It becomes evidence when the envelope —
 * signed by the merchant, naming this specific gate key — says the merchant
 * delegated to that gate, and bounded what it could do. The chain is:
 *
 *   merchant key ──signs──▶ envelope ──delegates──▶ gate key ──signs──▶ offer
 *
 * and every link has to hold. Break any one and the offer is a number in a JSON
 * document.
 *
 * WHAT IT DOES NOT PROVE
 *
 * Nothing here stops a merchant issuing an envelope with a 90% depth ceiling and
 * then honouring a 90% discount. That is not tampering; it is a merchant
 * choosing to be generous, and no signature scheme should try to prevent it.
 * What the buyer gets is narrower and more useful: whatever the merchant
 * published, the offer in hand is inside it, and the merchant cannot later say
 * its agent went rogue — because the merchant signed the limits the agent
 * stayed inside.
 *
 * The failure it *does* catch is the one that actually happens: an offer that
 * exceeds the published authority. Under a compromised or prompt-injected
 * selling agent that is exactly the shape the damage takes, and it is visible
 * from the outside, with no access to the merchant's systems, by anyone holding
 * these three inputs.
 */

import { verifySigned, type JsonObject, type PublicKeyRef } from '../crypto/index';
import {
  SellingMandateSchema,
  skuIsEligible,
  type SellingMandate,
} from '../mandate/schema';
import { OFFER_VERSION, type OfferBody } from '../gate/offer';
import type { Signature } from '../crypto/sign';

/**
 * The checks, in the order they run. Ordered by dependency: a signature check on
 * a document that did not parse is not a failing check, it is a meaningless one,
 * so verification stops at the first failure rather than reporting a cascade.
 */
export const COUNTERPARTY_CHECKS = [
  'envelope_wellformed',
  'envelope_signature',
  'envelope_in_force',
  'offer_wellformed',
  'offer_names_envelope',
  'gate_is_delegated',
  'offer_signature',
  'offer_unexpired',
  'arithmetic_consistent',
  'within_published_authority',
] as const;

export type CounterpartyCheck = (typeof COUNTERPARTY_CHECKS)[number];

export interface CheckResult {
  readonly check: CounterpartyCheck;
  readonly ok: boolean;
  /** What was established, or what was wrong. Written to be read aloud. */
  readonly detail: string;
}

export interface CounterpartyInput {
  /** The offer as received. Untrusted: assume every field is attacker-chosen. */
  readonly offer: JsonObject;
  /** The envelope the offer claims to act under. Equally untrusted. */
  readonly envelope: JsonObject;
  /** The merchant's key, from a directory the buyer already trusts. */
  readonly merchantPublicKey: PublicKeyRef;
  readonly now?: Date;
}

export type CounterpartyVerdict =
  | {
      readonly ok: true;
      readonly checks: readonly CheckResult[];
      /** Restated from the verified envelope, not from the offer. */
      readonly merchantId: string;
      readonly envelopeId: string;
      readonly offerId: string;
      readonly depthPct: number;
      readonly maxDepthPct: number;
      readonly offeredTotalInr: number;
    }
  | {
      readonly ok: false;
      readonly checks: readonly CheckResult[];
      readonly failed: CounterpartyCheck;
      readonly detail: string;
    };

/** The wire shape of a signed offer: the body, plus a signature, minus the brand. */
type WireOffer = OfferBody & { readonly signature: Signature };

/**
 * Run the chain. Pure: no clock unless one is handed in, no network, no keys
 * beyond the one supplied. A buyer can run this offline.
 */
export function verifyAsCounterparty(input: CounterpartyInput): CounterpartyVerdict {
  const now = input.now ?? new Date();
  const checks: CheckResult[] = [];

  const fail = (check: CounterpartyCheck, detail: string): CounterpartyVerdict => {
    checks.push({ check, ok: false, detail });
    return { ok: false, checks, failed: check, detail };
  };
  const pass = (check: CounterpartyCheck, detail: string): void => {
    checks.push({ check, ok: true, detail });
  };

  // --- 1. the envelope is a selling mandate at all -------------------------
  const parsed = SellingMandateSchema.safeParse(input.envelope);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(
      'envelope_wellformed',
      `not a selling mandate: ${first?.path.join('.') ?? '(root)'} — ${first?.message ?? 'invalid'}`,
    );
  }
  const envelope: SellingMandate = parsed.data;
  pass('envelope_wellformed', `envelope ${envelope.envelope_id} parses as ${envelope.version}`);

  // --- 2. the merchant actually issued it ----------------------------------
  const envelopeSignature = verifySigned(input.envelope, input.merchantPublicKey);
  if (!envelopeSignature.ok) {
    return fail(
      'envelope_signature',
      `envelope is not signed by ${input.merchantPublicKey.kid}: ${envelopeSignature.reason} — ${envelopeSignature.detail}`,
    );
  }
  pass(
    'envelope_signature',
    `signed by merchant key ${envelopeSignature.kid} at ${envelopeSignature.signed_at}`,
  );

  // --- 3. and it is in force right now --------------------------------------
  const issuedAt = Date.parse(envelope.issued_at);
  const expiresAt = Date.parse(envelope.expires_at);
  if (now.getTime() < issuedAt) {
    return fail('envelope_in_force', `envelope does not take effect until ${envelope.issued_at}`);
  }
  if (now.getTime() >= expiresAt) {
    return fail('envelope_in_force', `envelope expired at ${envelope.expires_at}`);
  }
  pass('envelope_in_force', `in force until ${envelope.expires_at}`);

  // --- 4. the offer is shaped like an offer ---------------------------------
  const offerCheck = readOffer(input.offer);
  if (offerCheck === null) {
    return fail('offer_wellformed', 'offer is missing required fields or has the wrong version');
  }
  const offer = offerCheck;
  pass('offer_wellformed', `offer ${offer.offer_id} parses as ${offer.version}`);

  // --- 5. it points at THIS envelope ----------------------------------------
  if (offer.envelope_id !== envelope.envelope_id) {
    return fail(
      'offer_names_envelope',
      `offer cites envelope ${offer.envelope_id}, but the envelope presented is ${envelope.envelope_id}`,
    );
  }
  if (offer.merchant_id !== envelope.merchant_id) {
    return fail(
      'offer_names_envelope',
      `offer is from merchant ${offer.merchant_id}, but the envelope was issued by ${envelope.merchant_id}`,
    );
  }
  pass('offer_names_envelope', `offer cites envelope ${envelope.envelope_id} of ${envelope.merchant_id}`);

  /**
   * --- 6. the signing gate is the delegated gate --------------------------
   *
   * The link that turns a signature into evidence. Checked BEFORE the signature
   * itself, because verifying against a key the envelope never delegated to
   * would produce a confident `ok: true` about nothing: proof that some
   * keyholder signed something, which was never in doubt.
   */
  if (offer.signature.kid !== envelope.gate_key.kid) {
    return fail(
      'gate_is_delegated',
      `offer was signed by gate ${offer.signature.kid}, but this merchant delegated only to ${envelope.gate_key.kid}`,
    );
  }
  pass('gate_is_delegated', `gate ${envelope.gate_key.kid} is the gate this envelope delegates to`);

  // --- 7. and the signature holds over the offer as received -----------------
  const gateRef: PublicKeyRef = {
    kid: envelope.gate_key.kid,
    role: 'gate',
    publicKeyPem: envelope.gate_key.public_key_pem,
  };
  const offerSignature = verifySigned(input.offer, gateRef);
  if (!offerSignature.ok) {
    return fail(
      'offer_signature',
      `offer signature does not verify: ${offerSignature.reason} — ${offerSignature.detail}`,
    );
  }
  pass('offer_signature', `signature verifies against the delegated gate key`);

  // --- 8. the offer is still live -------------------------------------------
  if (now.getTime() >= Date.parse(offer.expires_at)) {
    return fail('offer_unexpired', `offer expired at ${offer.expires_at}`);
  }
  pass('offer_unexpired', `offer holds until ${offer.expires_at}`);

  /**
   * --- 9. the numbers agree with each other -------------------------------
   *
   * Signed nonsense is still nonsense. An offer whose stated `depth_pct` does
   * not follow from its own totals is either a bug or a document engineered so
   * that a lazy verifier reads the harmless field while the rails read the
   * dangerous one. Both are worth catching, and the check is arithmetic.
   */
  const arithmetic = checkArithmetic(offer);
  if (arithmetic !== null) return fail('arithmetic_consistent', arithmetic);
  pass(
    'arithmetic_consistent',
    `₹${offer.offered_total_inr.toLocaleString('en-IN')} is ${offer.depth_pct}% off ₹${offer.list_total_inr.toLocaleString('en-IN')}`,
  );

  /**
   * --- 10. and it is inside what the merchant published --------------------
   *
   * The check no merchant-side code can make on the buyer's behalf, because it
   * is the merchant's own conduct being checked.
   */
  const breach = checkAuthority(offer, envelope);
  if (breach !== null) return fail('within_published_authority', breach);

  const ceiling = ceilingFor(offer, envelope);
  pass(
    'within_published_authority',
    `${offer.depth_pct}% is within the published ceiling of ${ceiling.pct}% (${ceiling.clause})`,
  );

  return {
    ok: true,
    checks,
    merchantId: envelope.merchant_id,
    envelopeId: envelope.envelope_id,
    offerId: offer.offer_id,
    depthPct: offer.depth_pct,
    maxDepthPct: ceiling.pct,
    offeredTotalInr: offer.offered_total_inr,
  };
}

/**
 * Read the fields this verifier depends on, or return null.
 *
 * Deliberately hand-rolled rather than reusing a schema from the gate. The buyer
 * is not running the merchant's code and should not have to: what a counterparty
 * needs is the published wire format, and a verifier that only works if you
 * already have the seller's validation library is not much of an independent
 * check.
 */
function readOffer(value: JsonObject): WireOffer | null {
  const o = value as Record<string, unknown>;
  if (o['version'] !== OFFER_VERSION) return null;

  const strings = ['offer_id', 'envelope_id', 'merchant_id', 'buyer_id', 'issued_at', 'expires_at'];
  if (strings.some((key) => typeof o[key] !== 'string')) return null;

  const numbers = ['list_total_inr', 'offered_total_inr', 'depth_pct'];
  if (numbers.some((key) => typeof o[key] !== 'number' || !Number.isFinite(o[key] as number))) return null;

  if (!Array.isArray(o['lines']) || o['lines'].length === 0) return null;
  for (const line of o['lines'] as unknown[]) {
    if (line === null || typeof line !== 'object') return null;
    const l = line as Record<string, unknown>;
    if (typeof l['sku'] !== 'string') return null;
    if (typeof l['quantity'] !== 'number' || typeof l['offered_unit_price_inr'] !== 'number') return null;
    if (typeof l['list_unit_price_inr'] !== 'number') return null;
  }

  const signature = o['signature'];
  if (signature === null || typeof signature !== 'object' || Array.isArray(signature)) return null;
  if (typeof (signature as Record<string, unknown>)['kid'] !== 'string') return null;

  return value as unknown as WireOffer;
}

/** Totals follow from lines, and the stated depth follows from the totals. */
function checkArithmetic(offer: WireOffer): string | null {
  const listFromLines = offer.lines.reduce((sum, l) => sum + l.list_unit_price_inr * l.quantity, 0);
  const offeredFromLines = offer.lines.reduce((sum, l) => sum + l.offered_unit_price_inr * l.quantity, 0);

  // A rupee of slack, because the gate rounds to whole rupees per line.
  if (Math.abs(listFromLines - offer.list_total_inr) > 1) {
    return `list total is ₹${offer.list_total_inr}, but the lines sum to ₹${listFromLines}`;
  }
  if (Math.abs(offeredFromLines - offer.offered_total_inr) > 1) {
    return `offered total is ₹${offer.offered_total_inr}, but the lines sum to ₹${offeredFromLines}`;
  }
  if (offer.list_total_inr <= 0) return 'list total must be positive';
  if (offer.offered_total_inr > offer.list_total_inr) {
    return `offered total ₹${offer.offered_total_inr} exceeds list ₹${offer.list_total_inr}`;
  }

  const impliedDepth = ((offer.list_total_inr - offer.offered_total_inr) / offer.list_total_inr) * 100;
  if (Math.abs(impliedDepth - offer.depth_pct) > 0.05) {
    return `offer states ${offer.depth_pct}% depth, but its own totals imply ${impliedDepth.toFixed(2)}%`;
  }
  return null;
}

/** Which published clause caps this offer, and at what. */
function ceilingFor(offer: WireOffer, envelope: SellingMandate): { pct: number; clause: string } {
  const units = offer.lines.reduce((sum, line) => sum + line.quantity, 0);
  const { authority } = envelope;
  if (units > 1) {
    return {
      pct: authority.bundle_rules.combined_depth_pct,
      clause: 'authority.bundle_rules.combined_depth_pct',
    };
  }
  return { pct: authority.max_discount_depth_pct, clause: 'authority.max_discount_depth_pct' };
}

/**
 * The published authority, checked from outside.
 *
 * Only the clauses a counterparty can actually evaluate. Floor margin needs unit
 * costs, and the daily budget needs every other offer issued today — neither is
 * public, and neither should be. Claiming to check them would be the more
 * impressive verifier and the less honest one.
 */
function checkAuthority(offer: WireOffer, envelope: SellingMandate): string | null {
  const { authority } = envelope;

  for (const line of offer.lines) {
    if (!skuIsEligible(line.sku, authority)) {
      return `${line.sku} is not sellable under this envelope (eligible: ${authority.eligible_skus.join(', ')}; excluded: ${authority.excluded_skus.join(', ') || 'none'})`;
    }
  }

  const units = offer.lines.reduce((sum, line) => sum + line.quantity, 0);
  if (units > authority.bundle_rules.max_items) {
    return `${units} units exceeds authority.bundle_rules.max_items (${authority.bundle_rules.max_items})`;
  }

  const ceiling = ceilingFor(offer, envelope);
  // Half a basis point of slack for the gate's own rounding, and no more.
  if (offer.depth_pct > ceiling.pct + 0.005) {
    return `offer grants ${offer.depth_pct}% off, exceeding the published ${ceiling.clause} of ${ceiling.pct}%`;
  }

  const perBuyerDiscount = offer.list_total_inr - offer.offered_total_inr;
  if (perBuyerDiscount > authority.per_buyer_discount_cap_inr) {
    return `₹${perBuyerDiscount} of discount exceeds authority.per_buyer_discount_cap_inr (₹${authority.per_buyer_discount_cap_inr})`;
  }

  return null;
}

/** One line per check, for a terminal or a panel. */
export function formatVerdict(verdict: CounterpartyVerdict): string {
  const lines = verdict.checks.map((c) => `  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.check.padEnd(26)} ${c.detail}`);
  const skipped = COUNTERPARTY_CHECKS.filter((c) => !verdict.checks.some((r) => r.check === c)).map(
    (c) => `  --    ${c.padEnd(26)} not reached`,
  );
  const head = verdict.ok
    ? `ACCEPTED  offer ${verdict.offerId} — ₹${verdict.offeredTotalInr.toLocaleString('en-IN')} at ${verdict.depthPct}%`
    : `REJECTED  ${verdict.failed}: ${verdict.detail}`;
  return [head, '', ...lines, ...skipped].join('\n');
}
