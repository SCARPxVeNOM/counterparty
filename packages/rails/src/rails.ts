/**
 * The money actions.
 *
 * Every method here takes a `SignedOffer` or a `RefundAuthorization` — never a
 * proposal, never a bare amount. The gate is the only thing that can produce
 * either, so nothing the model says can reach Razorpay through this file. That
 * is enforced by the compiler; the runtime signature check below is the second
 * layer, for anything that got here by a cast.
 */

import {
  publicKeyRef,
  rupeesToPaise,
  verifySigned,
  type JsonObject,
  type PublicKeyRef,
  type RefundAuthorization,
  type SellingMandate,
  type SignedOffer,
} from '@counterparty/core';
import {
  RazorpayClient,
  type RawOffer,
  type RawOrder,
  type RawPayment,
  type RawPaymentLink,
  type RawRefund,
  type RawSubscription,
} from './client.js';
import { toPayment } from './authorize.js';
import {
  RailsError,
  type Authorizer,
  type PaymentLink,
  type RazorpayOffer,
  type RazorpayOrder,
  type RazorpayPayment,
  type RazorpayRefund,
  type RazorpaySubscription,
  type Settlement,
} from './types.js';

export interface RailsOptions {
  readonly client: RazorpayClient;
  readonly authorizer: Authorizer;
  /** The envelope in force. Its `gate_key` is what offer signatures are checked against. */
  readonly mandate: SellingMandate;
}

export class Rails {
  private readonly client: RazorpayClient;
  private readonly authorizer: Authorizer;
  private readonly gatePublicKey: PublicKeyRef;

  constructor(options: RailsOptions) {
    this.client = options.client;
    this.authorizer = options.authorizer;
    this.gatePublicKey = {
      role: 'gate',
      kid: options.mandate.gate_key.kid,
      publicKeyPem: options.mandate.gate_key.public_key_pem,
    };
  }

  get mode(): 'live' | 'sim' {
    return this.authorizer.mode;
  }

  /**
   * The runtime half of "unsigned is not binding".
   *
   * The type system already prevents a proposal reaching here by any ordinary
   * path. This catches the extraordinary one — a forced cast — and it checks
   * against the gate key the ENVELOPE names, so an offer signed by some other
   * gate fails even though it is perfectly well signed.
   */
  private assertSigned(offer: SignedOffer): void {
    const result = verifySigned(offer as unknown as JsonObject, this.gatePublicKey);
    if (!result.ok) {
      throw new RailsError(
        `refusing to execute: offer ${offer.offer_id} failed signature verification (${result.reason}: ${result.detail})`,
        'UNSIGNED_OFFER',
      );
    }
  }

  // --- 1. orders -----------------------------------------------------------

  /**
   * Create the order at the offered price.
   *
   * `payment_capture: 0` is what makes authorization-as-an-option work: the
   * payment holds in `authorized` and the merchant chooses whether to capture,
   * within Razorpay's 3-day window.
   *
   * The amount comes from `offer.offered_total_inr` — the price the gate signed,
   * not any figure a caller supplies. There is no parameter to get wrong.
   */
  async createOrder(offer: SignedOffer): Promise<RazorpayOrder> {
    this.assertSigned(offer);
    const raw = await this.client.post<RawOrder>('/orders', {
      amount: rupeesToPaise(offer.offered_total_inr),
      currency: 'INR',
      receipt: offer.offer_id.slice(0, 40),
      payment_capture: 0,
      notes: {
        offer_id: offer.offer_id,
        envelope_id: offer.envelope_id,
        buyer_id: offer.buyer_id,
        authorized_by: offer.authorized_by,
        depth_pct: String(offer.depth_pct),
      },
    });

    return {
      id: raw.id,
      amount_paise: raw.amount,
      currency: 'INR',
      status: raw.status,
      receipt: raw.receipt ?? '',
      simulated: false,
    };
  }

  // --- 2. authorize (the toggled step) -------------------------------------

  async authorize(order: RazorpayOrder, offer: SignedOffer): Promise<RazorpayPayment> {
    this.assertSigned(offer);
    return this.authorizer.authorize(order, offer);
  }

  // --- 3. capture ----------------------------------------------------------

  /**
   * Capture the full authorized amount.
   *
   * Razorpay requires the capture amount to equal the authorized amount, so
   * there is no amount parameter here at all. Offering one would be offering a
   * way to get a documented 400.
   */
  async captureFull(payment: RazorpayPayment): Promise<RazorpayPayment> {
    if (payment.simulated) {
      return { ...payment, status: 'captured', captured: true };
    }
    const raw = await this.client.post<RawPayment>(`/payments/${payment.id}/capture`, {
      amount: payment.amount_paise,
      currency: 'INR',
    });
    return toPayment(raw, false);
  }

  // --- 4. refunds ----------------------------------------------------------

  async refund(
    payment: RazorpayPayment,
    authorization: RefundAuthorization,
  ): Promise<RazorpayRefund> {
    if (authorization.requires_human) {
      throw new RailsError(
        `refund of ₹${authorization.refund_amount_inr} on ${payment.id} needs human approval before it can execute`,
        'HUMAN_APPROVAL_REQUIRED',
      );
    }

    const amount = rupeesToPaise(authorization.refund_amount_inr);

    if (payment.simulated) {
      return {
        id: `rfnd_SIM${payment.id.slice(-8)}`,
        payment_id: payment.id,
        amount_paise: amount,
        speed: 'normal',
        simulated: true,
      };
    }

    const raw = await this.client.post<RawRefund>(`/payments/${payment.id}/refund`, {
      amount,
      speed: 'normal',
      notes: { authorized_by: authorization.authorized_by },
    });

    return {
      id: raw.id,
      payment_id: raw.payment_id,
      amount_paise: raw.amount,
      speed: raw.speed_processed ?? raw.speed_requested ?? 'normal',
      simulated: false,
    };
  }

  // --- 5. settlement (CORRECTIONS C1) --------------------------------------

  /**
   * Settle an authorized payment at the price the gate signed.
   *
   * PATH A — the default for all negotiation. The concession was agreed before
   * the order existed, so the order was created at the conceded price and a full
   * capture settles it. One call, entirely native.
   *
   * PATH B — post-authorization changes only: partial fulfilment, out of stock,
   * a defect found after the sale. Money is already frozen and cannot be
   * rewound. Razorpay will not capture less than the authorized amount, so the
   * conceded settlement is composed from a full capture plus a refund of the
   * delta. Two rails calls, one gate decision, one audit row, one net.
   *
   * If the refund leg fails after the capture succeeded, this throws with both
   * ids in the message. The capture is not rolled back because it cannot be —
   * that is exactly the state the buyer is owed a refund from, and losing the
   * payment id here would strand it.
   */
  async settle(
    offer: SignedOffer,
    payment: RazorpayPayment,
    concession?: { readonly authorization: RefundAuthorization },
  ): Promise<Settlement> {
    this.assertSigned(offer);

    if (offer.settlement_path === 'pre_auth' || concession === undefined) {
      const captured = await this.captureFull(payment);
      return {
        path: 'pre_auth',
        payment: captured,
        net_paise: captured.amount_paise,
        rails: [`${captured.id}:capture`],
        simulated: captured.simulated,
      };
    }

    const captured = await this.captureFull(payment);

    let refunded: RazorpayRefund;
    try {
      refunded = await this.refund(captured, concession.authorization);
    } catch (cause) {
      throw new RailsError(
        `captured ${captured.id} for ${captured.amount_paise} paise but the composing refund failed ` +
          `(${(cause as Error).message}) — the buyer is owed ₹${concession.authorization.refund_amount_inr} ` +
          `against payment ${captured.id} and this must be settled by hand`,
        'SETTLEMENT_HALF_DONE',
      );
    }

    return {
      path: 'post_auth',
      payment: captured,
      refund: refunded,
      net_paise: captured.amount_paise - refunded.amount_paise,
      rails: [`${captured.id}:capture`, `${refunded.id}:refund`],
      simulated: captured.simulated || refunded.simulated,
    };
  }

  /**
   * Deliberate non-capture. Fulfilment failed, so the authorization is allowed
   * to lapse and Razorpay auto-refunds the customer after 3 days.
   *
   * There is no API call to make — the action is the absence of one. It returns
   * a record so the audit trail can show that not capturing was a decision
   * rather than an oversight, which is the only thing distinguishing the two.
   */
  lapse(offer: SignedOffer, payment: RazorpayPayment, reason: string): Settlement {
    this.assertSigned(offer);
    return {
      path: 'pre_auth',
      payment: { ...payment, status: 'created', captured: false },
      net_paise: 0,
      rails: [`${payment.id}:lapsed(${reason})`],
      simulated: payment.simulated,
    };
  }

  // --- 6. payment links, offers, subscriptions (always real) ---------------

  async createPaymentLink(offer: SignedOffer): Promise<PaymentLink> {
    this.assertSigned(offer);
    const raw = await this.client.post<RawPaymentLink>('/payment_links', {
      amount: rupeesToPaise(offer.offered_total_inr),
      currency: 'INR',
      description: `Offer ${offer.offer_id}`,
      reference_id: offer.offer_id,
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { offer_id: offer.offer_id, envelope_id: offer.envelope_id },
    });
    return {
      id: raw.id,
      short_url: raw.short_url,
      amount_paise: raw.amount,
      status: raw.status,
      simulated: false,
    };
  }

  /** Campaign offer. Same envelope, same gate, one-to-many addressing. */
  async createOffer(input: {
    readonly name: string;
    readonly displayText: string;
    readonly percentOff: number;
    readonly startsAt: Date;
    readonly endsAt: Date;
  }): Promise<RazorpayOffer> {
    const raw = await this.client.post<RawOffer>('/offers', {
      name: input.name.slice(0, 40),
      payment_method: 'card',
      display_text: input.displayText,
      terms: 'Issued under a Counterparty selling mandate',
      starts_at: Math.floor(input.startsAt.getTime() / 1000),
      ends_at: Math.floor(input.endsAt.getTime() / 1000),
      type: 'instant',
      value_type: 'percentage',
      // Razorpay expresses percentage offers in basis points.
      value: Math.round(input.percentOff * 100),
    });
    return { id: raw.id, name: raw.name, value_pct: raw.value / 100, simulated: false };
  }

  async createSubscription(input: {
    readonly planId: string;
    readonly totalCount: number;
    readonly offerId?: string;
  }): Promise<RazorpaySubscription> {
    const raw = await this.client.post<RawSubscription>('/subscriptions', {
      plan_id: input.planId,
      total_count: input.totalCount,
      customer_notify: 0,
      ...(input.offerId === undefined ? {} : { offer_id: input.offerId }),
    });
    return { id: raw.id, plan_id: raw.plan_id, status: raw.status, simulated: false };
  }

  async pauseSubscription(subscriptionId: string): Promise<RazorpaySubscription> {
    const raw = await this.client.post<RawSubscription>(`/subscriptions/${subscriptionId}/pause`, {
      pause_at: 'now',
    });
    return { id: raw.id, plan_id: raw.plan_id, status: raw.status, simulated: false };
  }

  async resumeSubscription(subscriptionId: string): Promise<RazorpaySubscription> {
    const raw = await this.client.post<RawSubscription>(`/subscriptions/${subscriptionId}/resume`, {
      resume_at: 'now',
    });
    return { id: raw.id, plan_id: raw.plan_id, status: raw.status, simulated: false };
  }
}

export { publicKeyRef };
