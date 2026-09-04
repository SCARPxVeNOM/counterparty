/**
 * Where the money actually moves, from the console.
 *
 * Until this route existed, the console showed a negotiation, a gate and an
 * audit trail, and never touched Razorpay once. Every real money action lived
 * in a CLI script. On a track built around Razorpay that is the wrong place for
 * it — someone opening the console saw no Razorpay anywhere, and the claim that
 * "the negotiation IS the checkout" was true of the architecture and invisible
 * in the product.
 *
 * So: a signed offer goes to the rails from the screen it was signed on.
 *
 * WHAT IS REAL HERE
 *
 * The order and the capture are real Razorpay API calls against test mode, and
 * the ids returned are real objects you can look up in the Dashboard. The card
 * tap is simulated, and that is not a gap to close: authorising a payment is a
 * human pressing a button on their own device. `pnpm smoke:live --wait` is
 * where a real person taps a real card.
 *
 * WHAT THE RAILS WILL NOT ACCEPT
 *
 * `rails.createOrder` takes a `SignedOffer` and nothing else, and re-verifies
 * the gate signature before it calls Razorpay. This route cannot construct one;
 * it can only look up an offer the gate already signed in this session. An
 * offer id that is not in the session is a 404, not an amount to charge.
 */

import { NextResponse } from 'next/server';
import {
  evaluateRefund,
  paiseToRupees,
  poolPosition,
  rupeesToPaise,
  type AuditEntry,
} from '@counterparty/core';
import { Rails, RazorpayClient, SimAuthorizer } from '@counterparty/rails';
import { loadConfig } from '@counterparty/config';
import { demoMandate, gateKey } from '@counterparty/demo';
import { ledger, sessionFor } from '../session/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function railsFor() {
  const config = loadConfig();
  if (config.razorpayKeyId === '') return null;
  const client = new RazorpayClient({
    credentials: { keyId: config.razorpayKeyId, keySecret: config.razorpayKeySecret },
  });
  return new Rails({ client, authorizer: new SimAuthorizer(), mandate: demoMandate() });
}

/** The audit fields every row needs, filled from the session that signed the offer. */
function base(
  sessionId: string,
): Pick<AuditEntry, 'session_id' | 'envelope_id' | 'pressure_score' | 'budget_remaining_inr' | 'budget_limit_inr'> {
  const session = sessionFor(sessionId);
  const position = poolPosition(session.budget, new Date());
  return {
    session_id: sessionId,
    envelope_id: demoMandate().envelope_id,
    pressure_score: session.pressure.score,
    budget_remaining_inr: paiseToRupees(position.remaining),
    budget_limit_inr: paiseToRupees(position.limit),
  };
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    id?: string;
    offerId?: string;
    action?: 'settle' | 'refund' | 'link';
    refundInr?: number;
    paymentId?: string;
  };

  const sessionId = body.id ?? 'console';
  const rails = railsFor();
  if (rails === null) {
    return NextResponse.json(
      { error: 'No Razorpay credentials in .env, so nothing can be charged.' },
      { status: 503 },
    );
  }

  const session = sessionFor(sessionId);

  try {
    if (body.action === 'refund') {
      return NextResponse.json(await refund(rails, sessionId, body));
    }

    const offer = session.signedOffers.find((o) => o.offer_id === body.offerId);
    if (offer === undefined) {
      return NextResponse.json(
        { error: `no signed offer ${String(body.offerId)} in this session` },
        { status: 404 },
      );
    }

    /**
     * A real Razorpay Payment Link at the signed price.
     *
     * This is the track's "conversational in-app checkout" made literal: the
     * price was reached in conversation, the gate signed it, and the link is
     * something a person opens on their own phone and pays with their own card.
     * Nothing about it is simulated — the URL is live and the money is real
     * test-mode money.
     *
     * It is also the reason `payment_link_issued` had to become a money action.
     * A URL at a price is a commercial commitment anyone holding it can act on,
     * so it is gated and recorded like any other.
     */
    if (body.action === 'link') {
      const link = await rails.createPaymentLink(offer);
      ledger().append({
        ...base(sessionId),
        at: new Date().toISOString(),
        action: 'payment_link_issued',
        outcome: 'executed',
        authorized_by: offer.authorized_by,
        agent_rationale: `payment link at the signed price for ${offer.offer_id}`,
        offer_id: offer.offer_id,
        buyer_id: offer.buyer_id,
        amount_inr: offer.offered_total_inr,
        list_inr: offer.list_total_inr,
        depth_pct: offer.depth_pct,
        rails: [link.id],
        signature: offer.signature.sig,
      });
      return NextResponse.json({
        linkId: link.id,
        linkUrl: link.short_url,
        amountInr: offer.offered_total_inr,
        keyId: loadConfig().razorpayKeyId,
      });
    }

    // --- the money, in order -----------------------------------------------
    const order = await rails.createOrder(offer);
    const payment = await rails.authorize(order, offer);
    const settlement = await rails.settle(offer, payment);

    /**
     * Two rows, not one. An authorization and a capture are separate decisions
     * taken at separate moments — the whole point of §5.3 is that the gap
     * between them is an option the merchant holds — and collapsing them into
     * one row would hide the very thing the design is about.
     */
    ledger().append({
      ...base(sessionId),
      at: new Date().toISOString(),
      action: 'authorize',
      outcome: 'executed',
      authorized_by: 'authority.capture_window_hours',
      clause_value: demoMandate().authority.capture_window_hours,
      agent_rationale:
        `buyer authorized ${offer.offer_id} at the signed price` +
        (payment.simulated ? ' (simulated cardholder — no payment reached Razorpay)' : ''),
      offer_id: offer.offer_id,
      buyer_id: offer.buyer_id,
      amount_inr: offer.offered_total_inr,
      list_inr: offer.list_total_inr,
      depth_pct: offer.depth_pct,
      rails: [order.id, payment.id],
      signature: offer.signature.sig,
    });

    ledger().append({
      ...base(sessionId),
      at: new Date().toISOString(),
      action: 'capture_full',
      outcome: 'executed',
      authorized_by: 'authority.max_discount_depth_pct',
      clause_value: demoMandate().authority.max_discount_depth_pct,
      /**
       * Say when nothing executed.
       *
       * `captureFull` short-circuits on a simulated payment and never calls
       * `/payments/:id/capture`, so the order stays at `created` with no
       * payments against it. A row reading "executed" with no qualifier would be
       * the audit trail asserting something the Dashboard flatly contradicts —
       * which is the one failure this ledger cannot afford.
       */
      agent_rationale: payment.simulated
        ? `capture simulated on ${payment.id}; the order stands and no capture call was made`
        : `captured the full authorized amount on ${payment.id}`,
      offer_id: offer.offer_id,
      buyer_id: offer.buyer_id,
      amount_inr: settlement.net_paise / 100,
      settlement_path: settlement.path,
      rails: [...settlement.rails],
      signature: offer.signature.sig,
    });

    return NextResponse.json({
      orderId: order.id,
      paymentId: payment.id,
      amountInr: settlement.net_paise / 100,
      listInr: offer.list_total_inr,
      status: settlement.payment.status,
      path: settlement.path,
      simulatedCard: payment.simulated,
      rails: settlement.rails,
      keyId: loadConfig().razorpayKeyId,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}

/**
 * A refund the gate authorized, not one the caller asked for.
 *
 * `evaluateRefund` decides whether partials are permitted and whether the
 * amount crosses `requires_human_above_inr`; the rails refuse to execute an
 * authorization carrying `requires_human`. Asking for a refund and being
 * allowed to make one are different things, and this route is not the one that
 * decides.
 */
async function refund(
  rails: Rails,
  sessionId: string,
  body: { offerId?: string; paymentId?: string; refundInr?: number },
) {
  const session = sessionFor(sessionId);
  const offer = session.signedOffers.find((o) => o.offer_id === body.offerId);
  if (offer === undefined || body.paymentId === undefined) {
    return { error: 'a refund needs an offer from this session and a payment id' };
  }

  const amount = body.refundInr ?? offer.offered_total_inr;
  const decision = evaluateRefund(
    {
      kind: 'refund',
      buyerId: offer.buyer_id,
      paymentId: body.paymentId,
      capturedAmountInr: offer.offered_total_inr,
      refundAmountInr: amount,
      rationale: 'post-sale concession requested from the console',
    },
    {
      mandate: demoMandate(),
      gateKey,
      pricing: new Map(),
      budget: session.budget,
      pressure: session.pressure,
      now: new Date(),
      offerId: `${offer.offer_id}_rfnd`,
    },
  );

  if (!decision.ok) {
    ledger().append({
      ...base(sessionId),
      at: new Date().toISOString(),
      action: 'quote_refused',
      outcome: 'refused',
      authorized_by: decision.refusal.clause,
      agent_rationale: decision.refusal.reason,
      offer_id: offer.offer_id,
    });
    return { error: `${decision.refusal.clause}: ${decision.refusal.reason}` };
  }

  const executed = await rails.refund(
    {
      id: body.paymentId,
      order_id: '',
      amount_paise: rupeesToPaise(offer.offered_total_inr),
      status: 'captured',
      method: 'card',
      captured: true,
      authorized_at: new Date().toISOString(),
      simulated: false,
    },
    decision.authorization,
  );

  ledger().append({
    ...base(sessionId),
    at: new Date().toISOString(),
    action: decision.authorization.is_partial ? 'partial_refund' : 'full_refund',
    outcome: 'executed',
    authorized_by: decision.authorization.authorized_by,
    agent_rationale: `refunded ₹${amount} against ${body.paymentId}`,
    offer_id: offer.offer_id,
    buyer_id: offer.buyer_id,
    amount_inr: amount,
    rails: [executed.id],
  });

  return {
    refundId: executed.id,
    amountInr: amount,
    isPartial: decision.authorization.is_partial,
  };
}
