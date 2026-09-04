/**
 * An AI buyer transacts with this merchant, end to end, against real Razorpay.
 *
 *   pnpm buy              # real order, real capture, simulated card tap
 *   pnpm buy --rogue      # the offer is altered in transit; watch it walk
 *   pnpm buy --rogue --resign   # ...and re-signed by a key the envelope never named
 *
 * `pnpm demo` runs the same agent offline and deterministically. This one puts
 * real object ids on the screen, which is the difference between "the logic
 * works" and "money moved."
 *
 * WHAT IS AND IS NOT SIMULATED
 *
 * The order, the capture and the audit rows are real Razorpay and real
 * signatures. The card tap is simulated, and it has to be: authorizing a payment
 * is a human pressing a button on their own device, and an "autonomous" agent
 * that could do that on its own would be describing fraud rather than agentic
 * commerce. `pnpm smoke:live --wait` is where a real human taps a real card.
 *
 * That boundary is the honest one. Everything an agent may do, this agent does;
 * the one thing it may not do is the one thing it does not do.
 */

import {
  generateKeyPair,
  publicKeyRef,
  signPayload,
  type JsonObject,
  type SignedOffer,
} from '@counterparty/core';
import {
  BuyingAgent,
  LocalMerchant,
  Session,
  type BuyerMandate,
  type MerchantEndpoint,
  type PaymentReceipt,
} from '@counterparty/agents';
import { Rails, RazorpayClient, SimAuthorizer } from '@counterparty/rails';
import { MODELS, fromRepoRoot, loadConfig, readiness } from '@counterparty/config';
import { createProvider } from '@counterparty/llm';
import {
  CATALOG,
  DEMO_MERCHANT,
  ScriptedSeller,
  demoBudget,
  demoMandate,
  gateKey,
  merchantKey,
} from '@counterparty/demo';

const ROGUE = process.argv.includes('--rogue');
/** Re-sign the sweetened offer with a gate key of the attacker's own. */
const RESIGN = process.argv.includes('--resign');

/**
 * Why each failure means what it means, in one line.
 *
 * Derived rather than written, because the two attack shapes fail on different
 * checks and a script that narrated the wrong one would be describing a run it
 * did not just perform.
 */
const WHY: Readonly<Record<string, string>> = {
  offer_signature: 'the document was altered after the gate signed it.',
  gate_is_delegated: 'this merchant never delegated authority to the key that signed it.',
  within_published_authority: 'it exceeds the ceiling the merchant published and signed.',
  envelope_signature: 'the envelope it cites was not issued by this merchant.',
};

const MANDATE: BuyerMandate = {
  buyerId: 'buyer_autonomous',
  wants: 'kettle',
  quantity: 2,
  maxUnitPriceInr: 6000,
  maxTotalInr: 9600,
  protocols: ['ap2', 'upi-uap'],
};

function label(kind: string): string {
  return kind.replace(/_/g, ' ').padEnd(17);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const state = readiness(config);
  const mandate = demoMandate();

  console.log('\nCounterparty — an AI buyer transacts end to end\n');

  if (state.razorpay === 'missing') {
    console.error('No Razorpay credentials in .env. Run `pnpm demo` for the offline version.\n');
    process.exit(1);
  }

  /**
   * The seller side. Gemini writes the prose when a key is present; the gate,
   * the detectors, the signing and the audit chain run either way, because none
   * of them are downstream of the model.
   */
  const provider =
    config.geminiApiKey === ''
      ? new ScriptedSeller()
      : createProvider({ cassetteDir: fromRepoRoot('cassettes', 'buy'), config }).provider;

  const session = new Session({
    sessionId: `buy_${Date.now().toString(36)}`,
    buyerId: MANDATE.buyerId,
    mandate,
    gateKey,
    catalog: CATALOG,
    budget: demoBudget(),
    provider,
    sellingModel: MODELS.sellingAgent,
    classifierModel: MODELS.pressureClassifier,
    merchantName: DEMO_MERCHANT,
  });

  const client = new RazorpayClient({
    credentials: { keyId: config.razorpayKeyId, keySecret: config.razorpayKeySecret },
  });
  const rails = new Rails({ client, authorizer: new SimAuthorizer(), mandate });

  console.log(
    `  merchant: ${mandate.merchant_id}   agent: ${config.geminiApiKey === '' ? 'scripted' : 'gemini'}   ` +
      `rails: order and capture are real, the card tap is simulated\n`,
  );

  /** Real order, real capture. Only the cardholder is fictional. */
  const execute = async (offer: SignedOffer): Promise<PaymentReceipt> => {
    const order = await rails.createOrder(offer);
    const payment = await rails.authorize(order, offer);
    const settlement = await rails.settle(offer, payment);
    return {
      orderId: order.id,
      paymentId: payment.id,
      amountInr: settlement.net_paise / 100,
      status: settlement.payment.status,
      simulated: payment.simulated,
    };
  };

  const honest = new LocalMerchant({
    session,
    mandate,
    pricing: [...CATALOG.values()],
    titles: { 'SKU-KETTLE-1L': '1L Electric Kettle' },
    execute,
  });

  /**
   * The compromised merchant re-prices the offer after the gate signed it.
   *
   * A crude stand-in for a selling agent that has been talked into something, or
   * a channel someone is sitting in the middle of. What matters is that the
   * buyer's inputs are otherwise identical — same catalog, same envelope, same
   * key — so the only thing that changes the outcome is the check.
   */
  const merchant: MerchantEndpoint = ROGUE
    ? {
        catalog: () => honest.catalog(),
        envelope: () => honest.envelope(),
        say: async (message) => {
          const turn = await honest.say(message);
          if (turn.offer === undefined) return turn;

          const sweetened = {
            ...turn.offer,
            offered_total_inr: 3992,
            depth_pct: 60,
            lines: [
              {
                sku: 'SKU-KETTLE-1L',
                quantity: 2,
                list_unit_price_inr: 4990,
                offered_unit_price_inr: 1996,
              },
            ],
          };

          /**
           * Two shapes of the same attack, and they fail on different checks.
           *
           * Default: edit the offer in transit. The gate's signature no longer
           * matches, so `offer_signature` catches it — the check every signing
           * scheme already has.
           *
           * `--resign`: re-sign the edited offer with a key of the attacker's
           * own, so it arrives perfectly and validly signed. Nothing about the
           * signature is wrong; the envelope simply never delegated to that key.
           * That is the failure only a counterparty holding the envelope can
           * see, and it is the one worth demonstrating.
           */
          const offer = RESIGN
            ? (JSON.parse(
                JSON.stringify(
                  signPayload(
                    JSON.parse(JSON.stringify({ ...sweetened, signature: undefined })) as JsonObject,
                    generateKeyPair('gate'),
                    new Date(),
                  ),
                ),
              ) as JsonObject)
            : sweetened;

          return { reply: 'Special today — 60% off. ₹3,992 for the pair.', offer };
        },
        pay: async () => {
          throw new Error('the buyer should never have got here');
        },
      }
    : honest;

  const buyer = new BuyingAgent({
    mandate: MANDATE,
    merchant,
    merchantPublicKey: publicKeyRef(merchantKey),
    provider,
    model: MODELS.buyerPersona,
    maxTurns: 2,
  });

  console.log('  Nobody types anything below this line.\n');
  const run = await buyer.run();

  for (const step of run.steps) {
    console.log(`  ${label(step.kind)}${step.detail}`);
  }

  console.log('');

  switch (run.outcome.kind) {
    case 'purchased':
      console.log(
        `  PURCHASED  ₹${run.outcome.paidInr.toLocaleString('en-IN')} — order ${run.outcome.receipt.orderId}, ` +
          `payment ${run.outcome.receipt.paymentId}`,
      );
      console.log('\n  The order and the capture are real Razorpay objects. Look them up.');
      console.log('  The cardholder was simulated, and that is the only fiction in the run.\n');
      break;

    case 'refused':
      console.log(`  REFUSED  ${run.outcome.failedCheck}`);
      console.log(`           ${run.outcome.detail}`);
      console.log('\n  No order was created and no money moved. The buyer was offered 60% off');
      console.log(`  and declined it: ${WHY[run.outcome.failedCheck] ?? 'the chain of authority did not hold.'}`);
      console.log('\n  A buyer that checks only "is this signed?" pays.\n');
      break;

    case 'no_deal':
      console.log(`  NO DEAL  ${run.outcome.detail}\n`);
      break;
  }

  const audit = session.ledger.rows;
  if (audit.length > 0) {
    console.log(`  ${audit.length} audit row(s) on the merchant's side:`);
    for (const row of audit) {
      console.log(
        `    ${row.action.padEnd(20)} ${row.outcome.padEnd(9)} clause:${row.authorized_by}`,
      );
    }
    console.log('');
  }

  process.exit(run.outcome.kind === 'no_deal' ? 1 : 0);
}

main().catch((error) => {
  console.error('\nautonomous buy failed:', (error as Error).message, '\n');
  process.exit(1);
});
