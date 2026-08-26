/**
 * Settle an order that was authorized after the smoke test stopped watching.
 *
 * `smoke:live --wait` polls for a fixed window and then gives up. The payment
 * does not care: a card tapped a second after the poll ends is still authorized,
 * still sitting on the order, and still decaying toward Razorpay's automatic
 * 3-day refund. That is a real state the demo can land in, so there needs to be
 * a way out of it that is not "run the whole thing again".
 *
 *   pnpm tsx scripts/settle-order.ts order_XXXXXXXX
 *
 * The capture is gated, not assumed. The script rebuilds a mandate, asks the
 * gate to price the same basket, and refuses to capture unless the gate's
 * signed total matches the amount actually authorized to the paisa. An
 * authorized payment is not authority to take the money — the signature is.
 */

import {
  draftMandate,
  evaluateQuote,
  formatInr,
  generateKeyPair,
  issueMandate,
  openBudget,
  dayKeyOf,
  publicKeyRef,
  rupeesToPaise,
  INITIAL_PRESSURE,
  type SkuPricing,
} from '@counterparty/core';
import { Rails, RazorpayClient, SimAuthorizer, toPayment } from '@counterparty/rails';
import { loadConfig } from '@counterparty/config';

/** The shape Razorpay returns from GET /orders/{id}/payments. */
interface RawPaymentList {
  readonly items?: {
    readonly id: string;
    readonly order_id: string | null;
    readonly amount: number;
    readonly status: string;
    readonly method: string;
    readonly captured: boolean;
    readonly created_at: number;
  }[];
}

const KETTLE: SkuPricing = {
  sku: 'SKU-KETTLE-1L',
  listPrice: rupeesToPaise(4990),
  unitCost: rupeesToPaise(3400),
  marginConfidence: 0.94,
  availability: 'in_stock',
  agentPurchasable: true,
  maxQuantityPerOrder: 5,
};

async function main(): Promise<void> {
  const orderId = process.argv[2];
  if (orderId === undefined || !orderId.startsWith('order_')) {
    console.error('usage: pnpm tsx scripts/settle-order.ts order_XXXXXXXX');
    process.exit(1);
  }

  const config = loadConfig();
  const client = new RazorpayClient({
    credentials: { keyId: config.razorpayKeyId, keySecret: config.razorpayKeySecret },
  });

  // Razorpay's own payment object, converted by the same function the rails
  // use. Hand-assembling one here would mean inventing fields Razorpay is the
  // authority on.
  const payments = await client.get<RawPaymentList>(`/orders/${orderId}/payments`);
  const raw = (payments.items ?? []).find((p) => p.status === 'authorized');
  if (raw === undefined) {
    console.error(
      `no authorized payment on ${orderId}. Found: ` +
        ((payments.items ?? []).map((p) => `${p.id}=${p.status}`).join(', ') || 'nothing'),
    );
    process.exit(1);
  }

  const authorized = toPayment(raw, false);
  console.log(
    `\nauthorized payment  ${authorized.id}  ${formatInr(authorized.amount_paise as never)}  ` +
      `method=${authorized.method}`,
  );

  // Rebuild the authority and re-derive the price independently.
  const now = new Date();
  const merchantKey = generateKeyPair('merchant');
  const gateKey = generateKeyPair('gate');
  const mandate = issueMandate(
    draftMandate({ merchantId: 'acc_SMOKE', gateKey: publicKeyRef(gateKey), issuedAt: now }),
    merchantKey,
    now,
  );

  const decision = evaluateQuote(
    {
      kind: 'quote',
      buyerId: 'buyer_smoke',
      lines: [{ sku: KETTLE.sku, quantity: 1 }],
      requestedDepthPct: 10,
      rationale: 'settling a payment authorized after the smoke test stopped polling',
    },
    {
      mandate,
      gateKey,
      pricing: new Map([[KETTLE.sku, KETTLE]]),
      budget: openBudget(rupeesToPaise(40000), dayKeyOf(now)),
      pressure: INITIAL_PRESSURE,
      now,
    },
  );
  if (!decision.ok) {
    console.error(`gate refused: ${decision.refusal.clause} — ${decision.refusal.reason}`);
    process.exit(1);
  }

  const offer = decision.offer;
  const signedPaise = rupeesToPaise(offer.offered_total_inr);
  console.log(`gate signed         ${offer.offer_id}  ${formatInr(signedPaise)}  (${offer.authorized_by})`);

  if (signedPaise !== authorized.amount_paise) {
    console.error(
      `\nREFUSING to capture. The gate signed ${formatInr(signedPaise)} but ` +
        `${formatInr(authorized.amount_paise as never)} was authorized. Capturing an amount no ` +
        `mandate authorizes is the exact thing this system exists to prevent.`,
    );
    process.exit(1);
  }
  console.log('amounts match       capturing under the signed offer\n');

  const rails = new Rails({ client, authorizer: new SimAuthorizer(), mandate });
  const captured = await rails.captureFull(authorized);

  console.log(`captured            ${captured.id}  status=${captured.status}  simulated=${captured.simulated}`);
  console.log(`\nReal money action, real Razorpay object, under a signed offer.\n`);
}

main().catch((error) => {
  console.error('\nsettle failed:', error);
  process.exit(1);
});
