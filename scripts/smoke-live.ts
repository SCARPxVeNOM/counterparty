/**
 * Live smoke test against Razorpay test mode.
 *
 * The one command that proves the rails are real. Issues a mandate, has the
 * gate sign an offer, then walks it through every Razorpay object this system
 * creates — printing the actual ids so there is nothing to take on trust.
 *
 *   pnpm smoke:live           create everything, simulate the cardholder
 *   pnpm smoke:live --wait    print a payment link and wait for a real test card
 *
 * Test card: 4111 1111 1111 1111, any future expiry, any CVV.
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
import { LiveAuthorizer, Rails, RazorpayClient, SimAuthorizer } from '@counterparty/rails';
import { loadConfig, readiness } from '@counterparty/config';

const WAIT = process.argv.includes('--wait');

const KETTLE: SkuPricing = {
  sku: 'SKU-KETTLE-1L',
  listPrice: rupeesToPaise(4990),
  unitCost: rupeesToPaise(3400),
  marginConfidence: 0.94,
  availability: 'in_stock',
  agentPurchasable: true,
  maxQuantityPerOrder: 5,
};

function step(label: string, detail: string): void {
  console.log(`  ${'OK'.padEnd(5)}${label.padEnd(30)} ${detail}`);
}

async function attempt<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    const err = error as { code?: string; message?: string };
    console.log(`  ${'FAIL'.padEnd(5)}${label.padEnd(30)} ${err.code ?? ''} ${err.message ?? String(error)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const state = readiness(config);

  console.log('\nCounterparty — live rails smoke test\n');

  if (state.razorpay === 'missing') {
    console.error('No Razorpay credentials in .env. Nothing to smoke test.');
    process.exit(1);
  }
  if (state.razorpay === 'not_test_mode') {
    console.error(`REFUSING: ${config.razorpayKeyId} is not a test-mode key. This script creates real objects.`);
    process.exit(1);
  }
  console.log(`key ${config.razorpayKeyId.slice(0, 13)}…  mode=TEST\n`);

  // --- the mandate ---------------------------------------------------------
  const merchantKey = generateKeyPair('merchant');
  const gateKey = generateKeyPair('gate');
  const now = new Date();

  const mandate = issueMandate(
    draftMandate({ merchantId: 'acc_SMOKE', gateKey: publicKeyRef(gateKey), issuedAt: now }),
    merchantKey,
    now,
  );
  step('mandate issued', `envelope=${mandate.envelope_id} merchant_kid=${mandate.signature.kid}`);
  step('delegates to gate', mandate.gate_key.kid);

  // --- the gate signs an offer --------------------------------------------
  const decision = evaluateQuote(
    {
      kind: 'quote',
      buyerId: 'buyer_smoke',
      lines: [{ sku: KETTLE.sku, quantity: 1 }],
      requestedDepthPct: 10,
      rationale: 'smoke test: a concession inside every clause',
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
  step(
    'gate signed offer',
    `${offer.offer_id}  ${formatInr(rupeesToPaise(offer.offered_total_inr))} ` +
      `(list ${formatInr(rupeesToPaise(offer.list_total_inr))}, depth ${offer.depth_pct}%)`,
  );
  step('authorized by clause', offer.authorized_by);

  // --- the rails -----------------------------------------------------------
  const client = new RazorpayClient({
    credentials: { keyId: config.razorpayKeyId, keySecret: config.razorpayKeySecret },
  });
  const authorizer = WAIT
    ? new LiveAuthorizer(client, {
        pollIntervalMs: 3000,
        timeoutMs: 5 * 60 * 1000,
        onPending: (link, elapsed) =>
          console.log(`       waiting for payment… ${Math.round(elapsed / 1000)}s   ${link}`),
      })
    : new SimAuthorizer();
  const rails = new Rails({ client, authorizer, mandate });

  console.log(`\n  rails: authorize=${rails.mode} (everything else is real)\n`);

  const order = await attempt('orders.create', () => rails.createOrder(offer));
  if (order === null) {
    console.error('\nCould not create an order. Everything below depends on it.\n');
    process.exit(1);
  }
  step('orders.create', `${order.id}  ${formatInr(order.amount_paise as never)}  status=${order.status}`);

  const link = await attempt('payment_links.create', () => rails.createPaymentLink(offer));
  if (link !== null) step('payment_links.create', `${link.id}  ${link.short_url}`);

  // Campaign: a payment link at the gate-signed price. Razorpay has no
  // create-offer API (405 on POST /offers — see CORRECTIONS C6), so a campaign
  // draws on offers the merchant created in the Dashboard, if any.
  const campaignLink = await attempt('campaign link', () => rails.createCampaignLink(offer));
  if (campaignLink !== null) step('campaign link', `${campaignLink.id}  ${campaignLink.short_url}`);

  if (await rails.offersAvailable()) {
    const existingOffers = await attempt('offers.list', () => rails.listOffers());
    if (existingOffers !== null) {
      step(
        'offers.list',
        existingOffers.length === 0
          ? 'none yet — create one in the Dashboard to attach it to a campaign'
          : existingOffers.map((o) => `${o.id} (${o.value_pct}%)`).join(', '),
      );
    }
  } else {
    console.log(
      `  ${'SKIP'.padEnd(5)}${'offers'.padEnd(30)} Offers API not enabled on this account (no create API exists either)`,
    );
  }

  if (await rails.subscriptionsAvailable()) {
    const plan = await attempt('plans.create', () =>
      client.post<{ id: string }>('/plans', {
        period: 'monthly',
        interval: 1,
        item: { name: `CP smoke plan ${Date.now().toString(36)}`, amount: 49900, currency: 'INR' },
      }),
    );
    if (plan !== null) {
      step('plans.create', plan.id);
      const subscription = await attempt('subscriptions.create', () =>
        rails.createSubscription({ planId: plan.id, totalCount: 12 }),
      );
      if (subscription !== null) step('subscriptions.create', `${subscription.id}  status=${subscription.status}`);
    }
  } else {
    console.log(
      `  ${'SKIP'.padEnd(5)}${'subscriptions'.padEnd(30)} not enabled on this account — enable Subscriptions in the Dashboard`,
    );
  }

  // --- authorize, capture, refund -----------------------------------------
  if (WAIT && link !== null) {
    console.log(`\n  Pay this link with test card 4111 1111 1111 1111 to continue:\n  ${link.short_url}\n`);
  }

  const payment = await attempt('authorize', () => rails.authorize(order, offer));
  if (payment === null) {
    console.log('\nStopped before capture: no authorized payment.\n');
    return;
  }
  step('authorize', `${payment.id}  status=${payment.status}  simulated=${payment.simulated}`);

  const settlement = await attempt('settle (Path A)', () => rails.settle(offer, payment));
  if (settlement !== null) {
    step(
      'settle',
      `path=${settlement.path}  net=${formatInr(settlement.net_paise as never)}  ` +
        `rails=[${settlement.rails.join(', ')}]  simulated=${settlement.simulated}`,
    );
  }

  console.log(
    `\n${settlement?.simulated === false ? 'All objects above are real.' : 'Objects are real except the payment, which had a simulated cardholder.'}\n`,
  );
}

main().catch((error) => {
  console.error('\nsmoke test failed:', error);
  process.exit(1);
});
