/**
 * The shared discount budget.
 *
 * One pool, drawn on by both one-to-one negotiation and one-to-many campaigns.
 * That coupling is what makes the envelope an authority object rather than a
 * config file with two copies: burn ₹28k of margin on a win-back campaign in the
 * morning and the selling agent has correspondingly less room to concede in the
 * afternoon — it holds firmer, and its audit rows say why.
 *
 * RESERVE, DON'T JUST SPEND. A signed quote is an outstanding commitment: the
 * buyer may accept it, and if they do the merchant is bound. Counting only
 * accepted offers would let the agent issue ten quotes at ₹5k of discount each
 * against a ₹40k budget and find itself owing ₹50k when they all came back. So
 * signing a quote reserves against the pool for as long as the quote is live,
 * and the reservation expires exactly when the quote does.
 *
 * This module does accounting, not policy. It reports what has been spent and
 * what remains; the gate decides what any of that permits. Keeping the two
 * apart means a clause change never risks corrupting the ledger.
 */

import { ZERO, addPaise, paise, subPaise, type Paise } from '../money';

export const BUDGET_PURPOSES = ['negotiation', 'campaign'] as const;
export type BudgetPurpose = (typeof BUDGET_PURPOSES)[number];

export interface Reservation {
  readonly id: string;
  readonly amount: Paise;
  readonly buyerId: string;
  readonly purpose: BudgetPurpose;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface Commitment {
  readonly id: string;
  readonly amount: Paise;
  readonly buyerId: string;
  readonly purpose: BudgetPurpose;
  readonly committedAt: number;
}

export interface BudgetState {
  readonly dailyLimit: Paise;
  /** Day key in the merchant's timezone. A budget is a per-day grant. */
  readonly day: string;
  readonly commitments: readonly Commitment[];
  readonly reservations: readonly Reservation[];
}

export function openBudget(dailyLimit: Paise, day: string): BudgetState {
  return { dailyLimit, day, commitments: [], reservations: [] };
}

/**
 * Day key in Asia/Kolkata.
 *
 * An INR merchant's trading day is not UTC's. A budget that rolls over at
 * 05:30 local would hand the agent a fresh ₹40k in the middle of a working
 * morning, which is a discount budget with a bug in it.
 */
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function dayKeyOf(at: Date): string {
  return DAY_FORMAT.format(at);
}

/** Roll into a new trading day, discarding the previous day's ledger. */
export function ensureDay(state: BudgetState, at: Date): BudgetState {
  const day = dayKeyOf(at);
  return day === state.day ? state : openBudget(state.dailyLimit, day);
}

/** Drop reservations that have expired without being committed. */
export function expireStale(state: BudgetState, now: Date): BudgetState {
  const at = now.getTime();
  const live = state.reservations.filter((r) => r.expiresAt > at);
  return live.length === state.reservations.length ? state : { ...state, reservations: live };
}

export function spent(state: BudgetState): Paise {
  return state.commitments.reduce<Paise>((total, c) => addPaise(total, c.amount), ZERO);
}

export function reserved(state: BudgetState, now: Date): Paise {
  const at = now.getTime();
  return state.reservations.reduce<Paise>(
    (total, r) => (r.expiresAt > at ? addPaise(total, r.amount) : total),
    ZERO,
  );
}

/** Budget not yet spent and not currently held by a live quote. */
export function available(state: BudgetState, now: Date): Paise {
  const used = addPaise(spent(state), reserved(state, now));
  return used >= state.dailyLimit ? ZERO : subPaise(state.dailyLimit, used);
}

/**
 * What one buyer has drawn today, counting live reservations.
 *
 * Reservations count against the per-buyer cap for the same reason they count
 * against the pool: an outstanding quote is a commitment the buyer can still
 * take up.
 */
export function drawnByBuyer(state: BudgetState, buyerId: string, now: Date): Paise {
  const at = now.getTime();
  const committed = state.commitments
    .filter((c) => c.buyerId === buyerId)
    .reduce<Paise>((total, c) => addPaise(total, c.amount), ZERO);
  return state.reservations
    .filter((r) => r.buyerId === buyerId && r.expiresAt > at)
    .reduce<Paise>((total, r) => addPaise(total, r.amount), committed);
}

export type BudgetRefusal =
  | 'daily_budget_exhausted'
  | 'duplicate_reservation'
  | 'unknown_reservation'
  | 'reservation_expired';

export type ReserveResult =
  | { readonly ok: true; readonly state: BudgetState; readonly reservation: Reservation }
  | {
      readonly ok: false;
      readonly reason: BudgetRefusal;
      readonly detail: string;
      readonly available: Paise;
    };

export interface ReserveRequest {
  readonly id: string;
  readonly amount: Paise;
  readonly buyerId: string;
  readonly purpose: BudgetPurpose;
  /** How long the quote this reservation backs stays live. */
  readonly ttlMs: number;
}

export function reserve(state: BudgetState, request: ReserveRequest, now: Date): ReserveResult {
  const current = expireStale(ensureDay(state, now), now);
  const free = available(current, now);

  if (current.reservations.some((r) => r.id === request.id) ||
      current.commitments.some((c) => c.id === request.id)) {
    return {
      ok: false,
      reason: 'duplicate_reservation',
      detail: `${request.id} has already been reserved or committed`,
      available: free,
    };
  }

  if (request.amount > free) {
    return {
      ok: false,
      reason: 'daily_budget_exhausted',
      detail: `reserving ${request.amount} needs more than the ${free} remaining today`,
      available: free,
    };
  }

  const at = now.getTime();
  const reservation: Reservation = {
    id: request.id,
    amount: request.amount,
    buyerId: request.buyerId,
    purpose: request.purpose,
    createdAt: at,
    expiresAt: at + request.ttlMs,
  };

  return {
    ok: true,
    state: { ...current, reservations: [...current.reservations, reservation] },
    reservation,
  };
}

export type SettleResult =
  | { readonly ok: true; readonly state: BudgetState }
  | { readonly ok: false; readonly reason: BudgetRefusal; readonly detail: string };

/**
 * Turn a reservation into a commitment — the buyer accepted.
 *
 * An expired reservation cannot be committed. If the quote lapsed, the budget it
 * was holding has already been handed to someone else, and honouring it now
 * would overspend the pool by exactly the amount the reservation system exists
 * to prevent.
 */
export function commit(state: BudgetState, reservationId: string, now: Date): SettleResult {
  const at = now.getTime();
  const held = state.reservations.find((r) => r.id === reservationId);

  if (held === undefined) {
    return {
      ok: false,
      reason: 'unknown_reservation',
      detail: `no reservation ${reservationId}`,
    };
  }
  if (held.expiresAt <= at) {
    return {
      ok: false,
      reason: 'reservation_expired',
      detail: `reservation ${reservationId} expired at ${new Date(held.expiresAt).toISOString()}`,
    };
  }

  const commitment: Commitment = {
    id: held.id,
    amount: held.amount,
    buyerId: held.buyerId,
    purpose: held.purpose,
    committedAt: at,
  };

  return {
    ok: true,
    state: {
      ...state,
      reservations: state.reservations.filter((r) => r.id !== reservationId),
      commitments: [...state.commitments, commitment],
    },
  };
}

/** Hand budget back — the quote was refused, withdrawn or superseded. */
export function release(state: BudgetState, reservationId: string): SettleResult {
  if (!state.reservations.some((r) => r.id === reservationId)) {
    return { ok: false, reason: 'unknown_reservation', detail: `no reservation ${reservationId}` };
  }
  return {
    ok: true,
    state: { ...state, reservations: state.reservations.filter((r) => r.id !== reservationId) },
  };
}

/** Human-readable pool position, for audit rows: "₹11,200 / ₹40,000". */
export function poolPosition(state: BudgetState, now: Date): { remaining: Paise; limit: Paise } {
  return { remaining: available(state, now), limit: state.dailyLimit };
}

/** Restore a ledger from persisted rows. */
export function restoreBudget(
  dailyLimit: Paise,
  day: string,
  commitments: readonly Commitment[],
  reservations: readonly Reservation[],
): BudgetState {
  return { dailyLimit: paise(dailyLimit), day, commitments, reservations };
}
