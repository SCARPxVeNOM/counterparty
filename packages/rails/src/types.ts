/**
 * The rails surface — everything that moves money.
 *
 * WHERE THE SIMULATOR'S REACH ENDS
 *
 * The authorize-step toggle swaps exactly one thing: the moment a human taps a
 * card. It never fakes Razorpay. Orders, Payment Links, Offers, Plans and
 * Subscriptions are created against the real test-mode API in both modes,
 * because none of them require a payment to exist first.
 *
 * That rule has one consequence worth stating rather than glossing: capture and
 * refund act ON a payment. If the card-tap was simulated, no real payment
 * object exists, so there is nothing at Razorpay to capture or refund and those
 * calls are necessarily simulated too. The simulator's reach is precisely "the
 * payment object and whatever is downstream of it" — which follows from faking
 * the cardholder, and stops exactly there.
 *
 * Every response carries `simulated: boolean` so no caller, no audit row and no
 * pixel of the demo console can present a fabricated payment as a real one.
 *
 * The other invariant: every function here takes a `SignedOffer`. Not a
 * proposal, not an amount, not a plain object. The gate is the only thing that
 * can produce one, so the model's output cannot reach this file.
 */

import type { SignedOffer } from '@counterparty/core';

export const AUTHORIZE_MODES = ['live', 'sim'] as const;
export type AuthorizeMode = (typeof AUTHORIZE_MODES)[number];

/** Razorpay payment states this system cares about. */
export const PAYMENT_STATES = ['created', 'authorized', 'captured', 'refunded', 'failed'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export interface RazorpayOrder {
  readonly id: string;
  readonly amount_paise: number;
  readonly currency: 'INR';
  readonly status: string;
  readonly receipt: string;
  /** False only when the whole account is unreachable; orders are always real. */
  readonly simulated: false;
}

export interface RazorpayPayment {
  readonly id: string;
  readonly order_id: string;
  readonly amount_paise: number;
  readonly status: PaymentState;
  readonly method: string;
  readonly captured: boolean;
  readonly authorized_at: string;
  /**
   * True when the cardholder was simulated. Everything downstream of this
   * payment inherits the flag, because it inherits the fiction.
   */
  readonly simulated: boolean;
}

export interface RazorpayRefund {
  readonly id: string;
  readonly payment_id: string;
  readonly amount_paise: number;
  readonly speed: string;
  readonly simulated: boolean;
}

export interface PaymentLink {
  readonly id: string;
  readonly short_url: string;
  readonly amount_paise: number;
  readonly status: string;
  readonly simulated: false;
}

export interface RazorpayOffer {
  readonly id: string;
  readonly name: string;
  readonly value_pct: number;
  readonly simulated: false;
}

export interface RazorpaySubscription {
  readonly id: string;
  readonly plan_id: string;
  readonly status: string;
  readonly simulated: false;
}

/**
 * The result of settling an offer, whichever path was taken.
 *
 * Path A (pre_auth) produces one capture. Path B (post_auth) produces a capture
 * AND a refund, because Razorpay requires capture to equal the authorized
 * amount — see docs/CORRECTIONS.md C1. Both are one gated decision and one
 * audit row, so both report a single net.
 */
export interface Settlement {
  readonly path: 'pre_auth' | 'post_auth';
  readonly payment: RazorpayPayment;
  readonly refund?: RazorpayRefund;
  /** What the merchant actually keeps, after any composing refund. */
  readonly net_paise: number;
  /** Razorpay object references, for the audit row's `rails=[...]` field. */
  readonly rails: readonly string[];
  readonly simulated: boolean;
}

export class RailsError extends Error {
  override readonly name = 'RailsError';
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Turns a signed offer into an authorized payment.
 *
 * The one swappable seam. `LiveAuthorizer` puts a real payment link in front of
 * a human; `SimAuthorizer` fabricates the tap. Nothing else in the system
 * changes between modes.
 */
export interface Authorizer {
  readonly mode: AuthorizeMode;
  authorize(order: RazorpayOrder, offer: SignedOffer): Promise<RazorpayPayment>;
}
