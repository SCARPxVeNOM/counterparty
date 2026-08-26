/**
 * Execute a gated refund against a real captured payment.
 *
 *   pnpm tsx scripts/refund-payment.ts pay_XXXXXXXX 500        refund ₹500
 *   pnpm tsx scripts/refund-payment.ts pay_XXXXXXXX --full     refund everything
 *
 * Money actions #8 and #9. Both were implemented and unit-tested long before
 * either had touched live money, which is a gap worth closing rather than
 * describing: a refund path that has never returned a real `rfnd_` id is a
 * refund path with an untested assumption in it somewhere.
 *
 * The gate decides, not the caller. `evaluateRefund` checks the envelope's
 * refund authority — whether partials are permitted at all, and whether this
 * amount crosses `requires_human_above_inr` — and the rails refuse to execute
 * an authorization carrying `requires_human`. Asking for a refund is not the
 * same as being allowed to make one.
 */

import {
  draftMandate,
  evaluateRefund,
  formatInr,
  generateKeyPair,
  issueMandate,
  openBudget,
  dayKeyOf,
  publicKeyRef,
  rupeesToPaise,
  INITIAL_PRESSURE,
} from '@counterparty/core';
import { Rails, RazorpayClient, SimAuthorizer, toPayment } from '@counterparty/rails';
import { loadConfig } from '@counterparty/config';

interface RawPayment {
  readonly id: string;
  readonly order_id: string | null;
  readonly amount: number;
  readonly amount_refunded: number;
  readonly status: string;
  readonly method: string;
  readonly captured: boolean;
  readonly created_at: number;
}

async function main(): Promise<void> {
  const paymentId = process.argv[2];
  const amountArg = process.argv[3];

  if (paymentId === undefined || !paymentId.startsWith('pay_')) {
    console.error('usage: pnpm tsx scripts/refund-payment.ts pay_XXXXXXXX <rupees|--full>');
    process.exit(1);
  }

  const config = loadConfig();
  const client = new RazorpayClient({
    credentials: { keyId: config.razorpayKeyId, keySecret: config.razorpayKeySecret },
  });

  const raw = await client.get<RawPayment>(`/payments/${paymentId}`);
  if (raw.status !== 'captured') {
    console.error(`${paymentId} is ${raw.status}. Only a captured payment can be refunded.`);
    process.exit(1);
  }

  // Razorpay tracks cumulative refunds, so the refundable amount is what is
  // left, not what was captured. Refunding against the original figure twice
  // is how a payment gets over-refunded.
  const refundable = raw.amount - raw.amount_refunded;
  console.log(`\npayment    ${raw.id}  captured ${formatInr(raw.amount as never)}`);
  if (raw.amount_refunded > 0) {
    console.log(`refunded   ${formatInr(raw.amount_refunded as never)} already`);
  }
  console.log(`refundable ${formatInr(refundable as never)}`);

  if (refundable <= 0) {
    console.error('\nnothing left to refund.\n');
    process.exit(1);
  }

  const refundPaise = amountArg === '--full' ? refundable : rupeesToPaise(Number(amountArg));
  if (!Number.isFinite(refundPaise) || refundPaise <= 0) {
    console.error(`\n"${amountArg}" is not an amount in rupees.\n`);
    process.exit(1);
  }

  // --- the gate ------------------------------------------------------------
  const now = new Date();
  const merchantKey = generateKeyPair('merchant');
  const gateKey = generateKeyPair('gate');
  const mandate = issueMandate(
    draftMandate({ merchantId: 'acc_SMOKE', gateKey: publicKeyRef(gateKey), issuedAt: now }),
    merchantKey,
    now,
  );

  const decision = evaluateRefund(
    {
      kind: 'refund',
      buyerId: 'buyer_smoke',
      paymentId: raw.id,
      capturedAmountInr: refundable / 100,
      refundAmountInr: refundPaise / 100,
      rationale: 'post-sale concession, executed against a real captured payment',
    },
    {
      mandate,
      gateKey,
      pricing: new Map(),
      budget: openBudget(rupeesToPaise(40000), dayKeyOf(now)),
      pressure: INITIAL_PRESSURE,
      now,
    },
  );

  if (!decision.ok) {
    console.error(`\ngate refused: ${decision.refusal.clause}\n  ${decision.refusal.reason}\n`);
    process.exit(1);
  }

  const authorization = decision.authorization;
  console.log(`\ngate       ${authorization.is_partial ? 'PARTIAL' : 'FULL'} refund authorized`);
  console.log(`clause     ${authorization.authorized_by}`);
  console.log(`amount     ${formatInr(rupeesToPaise(authorization.refund_amount_inr))}`);

  if (authorization.requires_human) {
    console.log(
      `\nHELD. ${formatInr(rupeesToPaise(authorization.refund_amount_inr))} is above the ` +
        `envelope's requires_human_above_inr. The gate authorized the refund and ` +
        `deliberately did not execute it — that is the clause working, not a failure.\n`,
    );
    process.exit(0);
  }

  // --- the rails -----------------------------------------------------------
  const rails = new Rails({ client, authorizer: new SimAuthorizer(), mandate });
  const refund = await rails.refund(toPayment(raw, false), authorization);

  console.log(`\nrefunded   ${refund.id}  ${formatInr(refund.amount_paise as never)}  speed=${refund.speed}`);
  console.log(`simulated  ${refund.simulated}`);

  const after = await client.get<RawPayment>(`/payments/${paymentId}`);
  console.log(`\npayment now status=${after.status} refunded=${formatInr(after.amount_refunded as never)}\n`);
}

main().catch((error) => {
  console.error('\nrefund failed:', error);
  process.exit(1);
});
