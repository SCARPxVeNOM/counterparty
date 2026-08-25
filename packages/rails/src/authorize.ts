/**
 * The authorize step — the only thing the live/sim toggle swaps.
 *
 * Both authorizers receive an order that was created against the real Razorpay
 * API. They differ in exactly one respect: whether a human actually taps a card.
 */

import type { SignedOffer } from '@counterparty/core';
import { RazorpayClient, type RawPaymentLink, type RawList, type RawPayment } from './client';
import {
  RailsError,
  type Authorizer,
  type RazorpayOrder,
  type RazorpayPayment,
  type PaymentState,
} from './types';

/**
 * Puts a real payment link in front of a human and waits for them to pay.
 *
 * Produces a genuine payment in the `authorized` state, which real capture and
 * real refund calls can then act on. This is the path for the moment a judge
 * wants to try it themselves.
 *
 * Polling rather than webhooks by default. A webhook needs a public URL, which
 * needs ngrok, which is one more thing to fail on the night — and Razorpay's
 * payments list is perfectly adequate for a demo-length wait. `onPending` fires
 * each cycle so the console can show a QR code and a countdown rather than a
 * spinner.
 */
export class LiveAuthorizer implements Authorizer {
  readonly mode = 'live' as const;

  constructor(
    private readonly client: RazorpayClient,
    private readonly options: {
      readonly pollIntervalMs?: number;
      readonly timeoutMs?: number;
      readonly onPending?: (link: string, elapsedMs: number) => void;
      readonly now?: () => number;
      readonly sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  async authorize(order: RazorpayOrder, offer: SignedOffer): Promise<RazorpayPayment> {
    const interval = this.options.pollIntervalMs ?? 3000;
    const timeout = this.options.timeoutMs ?? 5 * 60 * 1000;
    const now = this.options.now ?? Date.now;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    const link = await this.client.post<RawPaymentLink>('/payment_links', {
      amount: order.amount_paise,
      currency: 'INR',
      description: `Offer ${offer.offer_id}`,
      reference_id: offer.offer_id,
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: {
        offer_id: offer.offer_id,
        envelope_id: offer.envelope_id,
        authorized_by: offer.authorized_by,
      },
    });

    const startedAt = now();
    for (;;) {
      const found = await this.findAuthorizedPayment(order.id);
      if (found !== null) return found;

      const elapsed = now() - startedAt;
      if (elapsed >= timeout) {
        throw new RailsError(
          `no payment authorized for order ${order.id} within ${Math.round(timeout / 1000)}s — the link at ${link.short_url} was never paid`,
          'AUTHORIZE_TIMEOUT',
        );
      }
      this.options.onPending?.(link.short_url, elapsed);
      await sleep(interval);
    }
  }

  private async findAuthorizedPayment(orderId: string): Promise<RazorpayPayment | null> {
    const payments = await this.client.get<RawList<RawPayment>>(`/orders/${orderId}/payments`);

    // A polling loop that crashes on an unexpected response shape reports a
    // TypeError from inside a retry, which says nothing about what went wrong
    // at the other end.
    if (!Array.isArray(payments?.items)) {
      throw new RailsError(
        `Razorpay returned no payment list for order ${orderId} — got ${JSON.stringify(payments).slice(0, 120)}`,
        'UNEXPECTED_RESPONSE',
      );
    }

    const usable = payments.items.find((p) => p.status === 'authorized' || p.status === 'captured');
    return usable === undefined ? null : toPayment(usable, false);
  }
}

/**
 * Fabricates the cardholder, and nothing else.
 *
 * The order it receives was created against the real API. What this does not do
 * is pretend Razorpay said anything — it stands in for the person, and the
 * payment it returns is marked `simulated: true` so that flag travels into every
 * audit row, every console panel and every downstream capture or refund.
 *
 * Payment ids are prefixed `pay_SIM` rather than mimicking Razorpay's format.
 * A simulated object that is indistinguishable from a real one is a trap for
 * whoever reads the logs later.
 */
export class SimAuthorizer implements Authorizer {
  readonly mode = 'sim' as const;

  constructor(
    private readonly options: {
      /** Injected so scenarios replay identically. */
      readonly idFor?: (order: RazorpayOrder) => string;
      readonly now?: () => Date;
      /** Simulate a cardholder who abandons the payment. */
      readonly failWith?: PaymentState;
      readonly method?: string;
    } = {},
  ) {}

  async authorize(order: RazorpayOrder, offer: SignedOffer): Promise<RazorpayPayment> {
    const at = (this.options.now ?? (() => new Date()))();
    const status = this.options.failWith ?? 'authorized';

    if (status === 'failed') {
      throw new RailsError(
        `simulated cardholder abandoned payment for order ${order.id}`,
        'SIMULATED_PAYMENT_FAILED',
      );
    }

    return {
      id: this.options.idFor?.(order) ?? `pay_SIM${offer.offer_id.replace(/[^A-Za-z0-9]/g, '').slice(-10)}`,
      order_id: order.id,
      amount_paise: order.amount_paise,
      status,
      method: this.options.method ?? 'card',
      captured: false,
      authorized_at: at.toISOString(),
      simulated: true,
    };
  }
}

export function toPayment(raw: RawPayment, simulated: boolean): RazorpayPayment {
  return {
    id: raw.id,
    order_id: raw.order_id ?? '',
    amount_paise: raw.amount,
    status: normalizeState(raw.status),
    method: raw.method,
    captured: raw.captured,
    authorized_at: new Date(raw.created_at * 1000).toISOString(),
    simulated,
  };
}

function normalizeState(status: string): PaymentState {
  switch (status) {
    case 'created':
    case 'authorized':
    case 'captured':
    case 'refunded':
    case 'failed':
      return status;
    default:
      return 'created';
  }
}
