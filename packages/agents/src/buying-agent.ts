/**
 * The AI buyer. Discovers, negotiates, verifies, and pays — with nobody typing.
 *
 * Every other buyer in this repo is a persona driving a chat box that a human
 * opened. This one runs a purchase end to end on its own: it reads the
 * merchant's published catalog, decides what it wants, negotiates, checks what
 * it is handed, and either pays or walks away.
 *
 * THE BOUNDARY IS THE POINT
 *
 * This module cannot import `Session`, `Rails`, the gate, or the merchant's
 * catalog records, and does not. It talks to a `MerchantEndpoint` that returns
 * JSON and nothing else — the same bytes a real buyer would receive over a wire.
 * That constraint is what makes the claim honest. An "autonomous buyer" holding
 * a live reference to the seller's session object is a function call wearing a
 * costume; it would pass every test and prove nothing about whether two parties
 * can transact.
 *
 * The consequence worth noticing: the buyer never sees `unitCost`. It negotiates
 * against a merchant whose floor it cannot see, which is the situation every
 * real buyer is in and the reason negotiation exists.
 *
 * THE BUYER HAS AUTHORITY TOO, AND IT IS NOT SIGNED HERE
 *
 * `BuyerMandate` is the buyer's own limit — what it may spend, on what, up to
 * what unit price. That is deliberately the shape of AP2's spending mandate,
 * because it is the artifact this project argues already exists. It is *not*
 * signed here, and pretending otherwise would be the overclaim this repo exists
 * to complain about: the buyer's signed authority is AP2's contribution, and
 * ours is the merchant's half. What this demonstrates is the two halves meeting.
 *
 * WALKING AWAY IS A RESULT
 *
 * The run can end in a purchase, and it can end in a refusal, and the refusal is
 * the more interesting outcome. An agent that pays for whatever it is sent is
 * not a counterparty — it is a payment button with extra steps.
 */

import {
  verifyAsCounterparty,
  type CounterpartyCheck,
  type JsonObject,
  type Protocol,
  type PublicKeyRef,
  type PublishedCatalog,
  type PublishedEntry,
  isBuyable,
} from '@counterparty/core';
import type { LLMProvider } from '@counterparty/llm';
import { PERSONAS, type Persona } from './buyer';

/** Rupees, the way a receipt writes them. Two decimals only when there are any. */
function inr(rupees: number): string {
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** What the buyer is authorized to do. AP2's half of the picture, unsigned. */
export interface BuyerMandate {
  readonly buyerId: string;
  /** Free text, for the model. What this agent was sent out to get. */
  readonly wants: string;
  readonly quantity: number;
  readonly maxUnitPriceInr: number;
  readonly maxTotalInr: number;
  readonly protocols: readonly Protocol[];
}

/** The seller, as JSON over a wire. The buyer knows nothing else about it. */
export interface MerchantEndpoint {
  /** The published feed. No unit costs, no margins. */
  catalog(): Promise<PublishedCatalog>;
  /** The selling mandate the catalog names, as published. Untrusted until checked. */
  envelope(): Promise<JsonObject>;
  /** One conversational turn. Returns the reply, and an offer if one was signed. */
  say(message: string): Promise<{ reply: string; offer?: JsonObject }>;
  /** Execute. Only ever called with an offer id the buyer has already verified. */
  pay(offerId: string): Promise<PaymentReceipt>;
}

export interface PaymentReceipt {
  readonly orderId: string;
  readonly paymentId: string;
  readonly amountInr: number;
  readonly status: string;
  readonly simulated: boolean;
}

export type StepKind =
  | 'discovered'
  | 'selected'
  | 'nothing_suitable'
  | 'fetched_envelope'
  | 'asked'
  | 'received_offer'
  | 'verified'
  | 'rejected_offer'
  | 'over_budget'
  | 'accepted'
  | 'paid'
  | 'gave_up';

export interface BuyerStep {
  readonly kind: StepKind;
  /** One line, written to be read aloud in a demo. */
  readonly detail: string;
  readonly failedCheck?: CounterpartyCheck;
}

export type BuyerOutcome =
  | { readonly kind: 'purchased'; readonly receipt: PaymentReceipt; readonly paidInr: number }
  | { readonly kind: 'refused'; readonly failedCheck: CounterpartyCheck; readonly detail: string }
  | { readonly kind: 'no_deal'; readonly detail: string };

export interface BuyerRun {
  readonly outcome: BuyerOutcome;
  readonly steps: readonly BuyerStep[];
  readonly transcript: ReadonlyArray<{ readonly speaker: 'buyer' | 'seller'; readonly text: string }>;
  /** Every offer this buyer was handed, and what it decided about each. */
  readonly verdicts: ReadonlyArray<{
    readonly offerId: string;
    readonly accepted: boolean;
    readonly failedCheck?: CounterpartyCheck;
  }>;
}

export interface BuyingAgentOptions {
  readonly mandate: BuyerMandate;
  readonly merchant: MerchantEndpoint;
  /**
   * The merchant's key, obtained out of band.
   *
   * Not fetched from the endpoint, and the type makes that impossible to do by
   * accident. A buyer that accepts the key its counterparty hands it has
   * verified that a document is self-consistent, which is a property a forger
   * supplies for free.
   */
  readonly merchantPublicKey: PublicKeyRef;
  readonly provider: LLMProvider;
  readonly model: string;
  /** Which negotiating stance to take. Defaults to the honest bulk buyer. */
  readonly persona?: Persona;
  readonly maxTurns?: number;
  readonly now?: () => Date;
}

export class BuyingAgent {
  private readonly steps: BuyerStep[] = [];
  private readonly transcript: Array<{ speaker: 'buyer' | 'seller'; text: string }> = [];
  private readonly verdicts: Array<{
    offerId: string;
    accepted: boolean;
    failedCheck?: CounterpartyCheck;
  }> = [];

  constructor(private readonly options: BuyingAgentOptions) {}

  private step(kind: StepKind, detail: string, failedCheck?: CounterpartyCheck): void {
    this.steps.push(failedCheck === undefined ? { kind, detail } : { kind, detail, failedCheck });
  }

  private done(outcome: BuyerOutcome): BuyerRun {
    return {
      outcome,
      steps: this.steps,
      transcript: this.transcript,
      verdicts: this.verdicts,
    };
  }

  async run(): Promise<BuyerRun> {
    const { mandate, merchant } = this.options;
    const maxTurns = this.options.maxTurns ?? 4;

    // --- 1. discover --------------------------------------------------------
    const catalog = await merchant.catalog();
    this.step(
      'discovered',
      `${catalog.entries.length} SKU(s) from ${catalog.merchant_id}, governed by envelope ${catalog.envelope_id}`,
    );

    const pick = this.select(catalog);
    if (pick === null) {
      const detail = `nothing in the catalog is agent-purchasable, in stock, on a protocol I speak, and at or under ₹${mandate.maxUnitPriceInr}`;
      this.step('nothing_suitable', detail);
      return this.done({ kind: 'no_deal', detail });
    }
    this.step(
      'selected',
      `${pick.sku} at ${inr(pick.list_price_inr)} list — ${mandate.quantity} of them would be ${inr(pick.list_price_inr * mandate.quantity)}, against my ceiling of ${inr(mandate.maxTotalInr)}`,
    );

    /**
     * The envelope is fetched from the merchant, and that is fine. It is
     * untrusted, and it is about to be checked against a key the merchant does
     * not control. Fetching it is discovery; believing it is verification.
     */
    const envelope = await merchant.envelope();
    this.step('fetched_envelope', `envelope ${String(envelope['envelope_id'])} retrieved, unverified`);

    // --- 2. negotiate -------------------------------------------------------
    const persona = this.options.persona ?? PERSONAS.honest_bulk_buyer;
    let message = this.opening(pick);

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      this.transcript.push({ speaker: 'buyer', text: message });
      this.step('asked', message.replace(/\s+/g, ' ').slice(0, 100));

      const { reply, offer } = await merchant.say(message);
      this.transcript.push({ speaker: 'seller', text: reply });

      if (offer !== undefined) {
        const decision = await this.judge(offer, envelope);
        if (decision !== null) return decision;
      }

      if (turn === maxTurns) break;

      message = await this.nextMessage(persona, turn + 1);
      if (message === '') break;
    }

    const detail = `${maxTurns} turn(s) and no offer I could both verify and afford`;
    this.step('gave_up', detail);
    return this.done({ kind: 'no_deal', detail });
  }

  /**
   * What the buyer does with an offer it has been handed.
   *
   * Returns a finished run when the offer settles the matter either way, and
   * `null` when the negotiation should continue. Verification comes strictly
   * before affordability: an offer that fails its checks is not a cheap offer or
   * an expensive one, it is not an offer, and asking whether it fits the budget
   * would be answering the wrong question about a document that should already
   * have been discarded.
   */
  private async judge(offer: JsonObject, envelope: JsonObject): Promise<BuyerRun | null> {
    const offerId = String(offer['offer_id'] ?? '(unidentified)');
    const totalInr = Number(offer['offered_total_inr'] ?? Number.NaN);
    this.step('received_offer', `${offerId} — ${inr(totalInr)} at ${String(offer['depth_pct'])}% off`);

    const verdict = verifyAsCounterparty({
      offer,
      envelope,
      merchantPublicKey: this.options.merchantPublicKey,
      ...(this.options.now === undefined ? {} : { now: this.options.now() }),
    });

    if (!verdict.ok) {
      this.verdicts.push({ offerId, accepted: false, failedCheck: verdict.failed });
      this.step('rejected_offer', verdict.detail, verdict.failed);
      /**
       * A failed check ends the run rather than prompting another turn.
       *
       * The failures this catches are not the kind that get better with more
       * conversation — an undelegated gate, an offer past its published
       * ceiling, a document edited after signing. Continuing to negotiate with
       * a counterparty that has just sent one of those is the behaviour the
       * check exists to prevent.
       */
      return this.done({ kind: 'refused', failedCheck: verdict.failed, detail: verdict.detail });
    }

    this.verdicts.push({ offerId, accepted: true });
    this.step(
      'verified',
      `all ${verdict.checks.length} checks pass — ${verdict.depthPct}% is inside the ${verdict.maxDepthPct}% ceiling ${verdict.merchantId} published and signed`,
    );

    /**
     * --- 3. and only now, can I afford it? --------------------------------
     *
     * Over budget is not a refusal. The offer is genuine and the merchant did
     * nothing wrong; this buyer simply is not authorized to accept it. So the
     * negotiation continues, which is the whole reason a buyer has a mandate of
     * its own rather than paying whatever it verifies.
     */
    if (totalInr > this.options.mandate.maxTotalInr) {
      this.step(
        'over_budget',
        `${inr(totalInr)} is over my ${inr(this.options.mandate.maxTotalInr)} ceiling — a valid offer I am not authorized to accept`,
      );
      return null;
    }

    this.step('accepted', `${inr(totalInr)} verified and within mandate — paying`);

    const receipt = await this.options.merchant.pay(offerId);
    this.step(
      'paid',
      `${inr(receipt.amountInr)} — order ${receipt.orderId}, payment ${receipt.paymentId} (${receipt.status}${
        receipt.simulated ? ', simulated card' : ''
      })`,
    );

    return this.done({ kind: 'purchased', receipt, paidInr: receipt.amountInr });
  }

  /**
   * Pick something to buy.
   *
   * Cheapest qualifying SKU that meets the stated need. Deliberately not a model
   * call: choosing between two prices is arithmetic, and routing it through an
   * LLM would add a way for the selection to be wrong without adding a way for
   * it to be better.
   */
  private select(catalog: PublishedCatalog): PublishedEntry | null {
    const { mandate } = this.options;
    const wanted = mandate.wants.toLowerCase();

    const candidates = catalog.entries
      .filter((entry) => isBuyable(entry, mandate.protocols))
      .filter((entry) => entry.list_price_inr <= mandate.maxUnitPriceInr)
      .filter((entry) => entry.max_quantity_per_order >= mandate.quantity)
      .filter(
        (entry) =>
          wanted === '' ||
          entry.sku.toLowerCase().includes(wanted) ||
          entry.title.toLowerCase().includes(wanted),
      );

    return candidates.sort((a, b) => a.list_price_inr - b.list_price_inr)[0] ?? null;
  }

  private opening(pick: PublishedEntry): string {
    const { mandate } = this.options;
    return (
      `Hi — I am buying on behalf of a customer. I need ${mandate.quantity} of ${pick.sku} ` +
      `(${pick.title}), listed at ${inr(pick.list_price_inr)} each. ` +
      `What can you do on price for ${mandate.quantity}?`
    );
  }

  private async nextMessage(persona: Persona, turn: number): Promise<string> {
    const history = this.transcript.map((entry) => ({
      role: entry.speaker === 'buyer' ? ('model' as const) : ('user' as const),
      text: entry.text,
    }));

    try {
      const { text } = await this.options.provider.generate({
        model: this.options.model,
        system: `${persona.brief}

You are an autonomous purchasing agent talking to a merchant's selling agent. You have a hard
budget ceiling of ${inr(this.options.mandate.maxTotalInr)} in total and you may not exceed it.
Reply with ONE short message — two or three sentences at most. Output only the message.`,
        label: `buying-agent-turn-${turn}`,
        temperature: 0.7,
        messages: history,
      });
      return text.trim();
    } catch {
      return '';
    }
  }
}
