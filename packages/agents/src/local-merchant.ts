/**
 * A `MerchantEndpoint` backed by a `Session` in this process.
 *
 * The buyer must not hold a reference to the seller. It holds this instead, and
 * this is the only place the two sides touch — so the seam is one file, and what
 * crosses it is visible in one screen of code.
 *
 * EVERYTHING CROSSING THE BOUNDARY IS SERIALIZED
 *
 * `JSON.parse(JSON.stringify(...))` on every outbound document is not
 * defensive habit, it is the property under test. A `SignedOffer` handed across
 * as a live object carries its brand, its prototype, and any field that happens
 * to be on it; the same offer over a wire carries only what survives JSON. If
 * the buyer's checks passed on the first and failed on the second, the buyer
 * would be verifying something no real counterparty ever receives.
 *
 * The same reasoning applies in reverse. This adapter hands back the offer the
 * gate signed and nothing else — not the session, not the budget, not the
 * pressure state, and above all not the catalog records with unit costs in them.
 *
 * WHY THE PAYMENT LOOKUP IS BY ID
 *
 * `pay(offerId)` takes a string, not an offer. The buyer cannot hand back a
 * document and have it executed — it names one the merchant already signed, and
 * the merchant re-finds its own copy. A buyer that could submit an offer object
 * for payment would be a buyer that could submit an edited one, and the whole
 * arrangement would rest on the merchant remembering to check.
 */

import {
  publishCatalog,
  type JsonObject,
  type Protocol,
  type PublishedCatalog,
  type SellingMandate,
  type SignedOffer,
  type SkuPricing,
} from '@counterparty/core';
import type { MerchantEndpoint, PaymentReceipt } from './buying-agent';
import type { Session } from './session';

/** What the adapter needs in order to actually move money. */
export interface PaymentExecutor {
  (offer: SignedOffer): Promise<PaymentReceipt>;
}

export interface LocalMerchantOptions {
  readonly session: Session;
  readonly mandate: SellingMandate;
  readonly pricing: Iterable<SkuPricing>;
  readonly titles?: Readonly<Record<string, string>>;
  readonly protocols?: readonly Protocol[];
  readonly publishedAt?: Date;
  /**
   * How a purchase executes. Injected so this file has no dependency on rails —
   * the demo hands in a simulated authorizer, a live run hands in Razorpay, and
   * neither is visible from here.
   */
  readonly execute: PaymentExecutor;
}

const wire = <T>(value: T): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;

export class LocalMerchant implements MerchantEndpoint {
  constructor(private readonly options: LocalMerchantOptions) {}

  async catalog(): Promise<PublishedCatalog> {
    const { mandate } = this.options;
    return wire(
      publishCatalog(this.options.pricing, {
        merchantId: mandate.merchant_id,
        envelopeId: mandate.envelope_id,
        ...(this.options.publishedAt === undefined ? {} : { publishedAt: this.options.publishedAt }),
        ...(this.options.titles === undefined ? {} : { titles: this.options.titles }),
        ...(this.options.protocols === undefined ? {} : { protocols: this.options.protocols }),
      }),
    ) as unknown as PublishedCatalog;
  }

  async envelope(): Promise<JsonObject> {
    return wire(this.options.mandate);
  }

  async say(message: string): Promise<{ reply: string; offer?: JsonObject }> {
    const turn = await this.options.session.takeTurn(message);
    return {
      reply: turn.agentMessage,
      ...(turn.offer === undefined ? {} : { offer: wire(turn.offer) }),
    };
  }

  async pay(offerId: string): Promise<PaymentReceipt> {
    const offer = this.options.session.signedOffers.find((o) => o.offer_id === offerId);
    if (offer === undefined) {
      throw new Error(`no signed offer ${offerId} in this session — nothing to pay for`);
    }
    return this.options.execute(offer);
  }
}
