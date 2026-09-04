/**
 * A win-back campaign against the merchant's real abandoned checkouts.
 *
 *   pnpm campaign:live
 *
 * §7 aims campaigns at recorded failures already sitting in the account. For
 * most of this build the cohort was invented — labelled `[SYNTHETIC SEGMENT]` in
 * every audit row, because a made-up audience is a legitimate thing to demo and
 * an illegitimate thing to present as real. This reads the actual account.
 *
 * Every member is a real Razorpay order id that was created and never paid, or
 * one carrying a real failed payment. The gate prices each one against the same
 * envelope a negotiation uses, drawing on the same daily budget, and refuses the
 * moment the pool runs dry.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not message anybody. Reaching those buyers means sending payment links
 * to real contact details, and this account's orders have none — they were made
 * by scripts, not customers. What runs here is every step up to and including
 * the signed, budgeted, audited authority to make the offer. The delivery
 * channel is the one piece that would differ against a live merchant, and
 * pretending otherwise would put the fiction back where it started.
 */

import { formatInr, rupeesToPaise, verifyChain } from '@counterparty/core';
import { runCampaign, type Segment } from '@counterparty/agents';
import { RazorpayClient, lapsedAuthorizationCohort, haltedSubscriptionCohort } from '@counterparty/rails';
import { loadConfig } from '@counterparty/config';
import { CATALOG, demoBudget, demoMandate, gateKey } from '@counterparty/demo';

const DEPTH = Number(process.argv.find((a) => a.startsWith('--depth='))?.split('=')[1] ?? 12);

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.razorpayKeyId === '') {
    console.error('\nNo Razorpay credentials in .env.\n');
    process.exit(1);
  }

  const client = new RazorpayClient({
    credentials: { keyId: config.razorpayKeyId, keySecret: config.razorpayKeySecret },
  });

  console.log('\nCounterparty — win-back campaign against the live account\n');

  const [lapsed, halted] = await Promise.all([
    lapsedAuthorizationCohort(client, { sku: 'SKU-KETTLE-1L', quantity: 1, minAmountInr: 100 }),
    haltedSubscriptionCohort(client, { sku: 'SKU-ESPRESSO-PRO', quantity: 1 }),
  ]);

  console.log(`  ${lapsed.name}`);
  console.log(`    ${lapsed.members.length} member(s), source=${lapsed.source}`);
  console.log(`  ${halted.name}`);
  console.log(
    `    ${halted.members.length} member(s), source=${halted.source}` +
      (halted.members.length === 0
        ? ' — none yet; a halted subscription needs a card tap and four failed charges'
        : ''),
  );

  const members = [...lapsed.members, ...halted.members];
  if (members.length === 0) {
    console.error('\n  No recoverable customers in this account. Nothing to campaign at.\n');
    process.exit(1);
  }

  const segment: Segment = {
    id: lapsed.id,
    name: halted.members.length === 0 ? lapsed.name : 'Abandoned checkouts and halted subscriptions',
    source: 'razorpay_lapsed_authorizations',
    members,
  };

  console.log(`\n  Every buyer below is a real object in ${config.razorpayKeyId}.`);
  /**
   * Said out loud because the two numbers on each line do not match.
   *
   * The label reports what that buyer actually abandoned; the offer is one
   * standard win-back SKU. A real merchant would offer the abandoned basket
   * back, and could — the line items are in their order notes. These orders were
   * created by scripts and mostly carry none, so reconstructing a basket from
   * them would mean inventing one, which is the thing this script exists to stop
   * doing.
   */
  console.log('  The label is what they abandoned; the offer is one standard win-back SKU.\n');

  const result = runCampaign({
    campaignId: `camp_live_${Date.now().toString(36)}`,
    mandate: demoMandate(),
    gateKey,
    catalog: CATALOG,
    budget: demoBudget(),
    segment,
    depthPct: DEPTH,
    rationale: `win-back at ${DEPTH}% against abandoned checkouts read from the live account`,
  });

  for (const outcome of result.outcomes) {
    const { member } = outcome;
    if (outcome.offer !== undefined) {
      console.log(
        `  SIGNED   ${member.buyerId}  ${formatInr(rupeesToPaise(outcome.offer.offered_total_inr))} ` +
          `at ${outcome.offer.depth_pct}%  clause:${outcome.offer.authorized_by}`,
      );
      console.log(`           ${member.label}`);
    } else {
      console.log(`  REFUSED  ${member.buyerId}  clause:${outcome.refusal?.clause}`);
      console.log(`           ${outcome.refusal?.reason}`);
    }
  }

  const limitInr = demoMandate().authority.discount_budget_inr_per_day;
  const remaining = limitInr - result.committedInr;

  console.log(`\n  reached ${result.reached}, refused ${result.refused}`);
  console.log(
    `  committed ${formatInr(rupeesToPaise(result.committedInr))} of ` +
      `${formatInr(rupeesToPaise(limitInr))} — ` +
      `${formatInr(rupeesToPaise(remaining))} left for negotiations today`,
  );
  console.log(`  synthetic: ${result.synthetic}`);
  console.log(`  audit chain over ${result.ledger.rows.length} row(s): ${verifyChain(result.ledger.rows).ok ? 'INTACT' : 'BROKEN'}`);

  if (!result.synthetic) {
    console.log('\n  No [SYNTHETIC SEGMENT] prefix on any row above. That prefix is not');
    console.log('  decoration — it is how a reader six months from now tells a demo cohort');
    console.log('  from a real one without knowing how the demo was configured.\n');
  }

  console.log(`  Razorpay objects this cohort was built from: ${lapsed.evidence.length}`);
  console.log(`    ${lapsed.evidence.slice(0, 6).join(', ')}${lapsed.evidence.length > 6 ? ', …' : ''}\n`);

  process.exit(result.reached > 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nlive campaign failed:', (error as Error).message, '\n');
  process.exit(1);
});
