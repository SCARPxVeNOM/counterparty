/**
 * What the envelope was worth, over every recorded negotiation.
 *
 *   pnpm revenue              # all six personas, from cassettes, no key needed
 *   pnpm revenue --cap 10     # against a stingier flat cap
 *
 * `pnpm demo` prints this over four scripted scenarios, which is a small base to
 * rest a number on. This runs it over the eighteen turns in `cassettes/console/`
 * — real Gemini prose across all six buyer personas, re-adjudicated by the real
 * gate on every run.
 *
 * The model is fixed; nothing downstream of it is. Every signature, every clause
 * check, every pressure decision and every audit row below is produced now, by
 * the same code the console runs. Replaying the model does not weaken the
 * figure, because the figure is computed from the gate's decisions and the gate
 * is not a recording.
 *
 * WHY IT IS PER-PERSONA
 *
 * A single total hides the argument. The envelope and a flat cap price honest
 * traffic identically and diverge only where something was binding, so the
 * interesting output is *which* personas moved the number and which did not.
 * A merchant reading one aggregate cannot tell whether they bought protection or
 * just bought a smaller business.
 */

import {
  counterfactual,
  formatCounterfactual,
  type AuditRow,
} from '@counterparty/core';
import { PERSONAS, Session } from '@counterparty/agents';
import { MODELS, type Config } from '@counterparty/config';
import { createProvider } from '@counterparty/llm';
import {
  CATALOG,
  CONSOLE_CASSETTE_DIR,
  DEMO_MERCHANT,
  consoleTurns,
  demoBudget,
  demoMandate,
  gateKey,
} from '@counterparty/demo';

/**
 * `--cap 10` and `--cap=10`, and 15 when neither is given.
 *
 * The obvious one-liner — `Number(argv[argv.indexOf('--cap') + 1] ?? 15)` —
 * reads `argv[0]` when the flag is absent, because `indexOf` returns -1. That is
 * the node binary path, `Number` of it is NaN, and NaN silently poisons every
 * comparison downstream into reporting a flat cap that grants nothing. Which is
 * exactly what it did the first time this ran.
 */
function capPct(): number {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith('--cap='));
  if (inline !== undefined) return Number(inline.slice('--cap='.length));

  const at = argv.indexOf('--cap');
  const next = at === -1 ? undefined : argv[at + 1];
  const parsed = next === undefined ? Number.NaN : Number(next);
  return Number.isFinite(parsed) ? parsed : 15;
}

const CAP = capPct();

/** Keyless on purpose: a cassette miss must throw rather than quietly cost a token. */
const KEYLESS: Config = {
  razorpayKeyId: '',
  razorpayKeySecret: '',
  geminiApiKey: '',
  authorizeMode: 'sim',
  llmMode: 'cassette',
  publicBaseUrl: '',
  razorpayWebhookSecret: '',
};

function sessionFor(personaId: string): Session {
  const { provider } = createProvider({
    cassetteDir: CONSOLE_CASSETTE_DIR,
    config: KEYLESS,
    force: 'replay',
  });
  return new Session({
    // The cassettes were recorded under one session id; the hash keys on the
    // request, not the session, but keeping it stable keeps offer ids readable.
    sessionId: 'console',
    buyerId: `buyer_${personaId}`,
    mandate: demoMandate(),
    gateKey,
    catalog: CATALOG,
    budget: demoBudget(),
    provider,
    sellingModel: MODELS.sellingAgent,
    classifierModel: MODELS.pressureClassifier,
    merchantName: DEMO_MERCHANT,
  });
}

async function main(): Promise<void> {
  console.log('\nCounterparty — what the envelope earned, over every recorded negotiation\n');
  console.log('  Replayed from cassettes/console/. Real Gemini prose, re-adjudicated live by');
  console.log('  the gate: every signature, clause check and pressure decision below is being');
  console.log('  made now, not read back.\n');

  const rows: AuditRow[] = [];
  const perPersona: Array<{
    id: string;
    adversarial: boolean;
    deltaInr: number;
    turns: number;
    clause: string;
  }> = [];

  for (const persona of Object.values(PERSONAS)) {
    const session = sessionFor(persona.id);
    const turns = consoleTurns(persona);

    for (const message of turns) {
      await session.takeTurn(message);
    }

    /**
     * Re-key each persona's rows to its own buyer id.
     *
     * All six replay under one session id, so without this the counterfactual's
     * "last signed offer per buyer per session" rule would collapse six
     * negotiations into one and report a single deal.
     */
    const own = session.ledger.rows.map((row) => ({
      ...row,
      session_id: persona.id,
      ...(row.buyer_id === undefined ? {} : { buyer_id: `buyer_${persona.id}` }),
    })) as AuditRow[];

    rows.push(...own);

    const solo = counterfactual(own, { capPct: CAP });
    perPersona.push({
      id: persona.id,
      adversarial: persona.adversarial,
      deltaInr: solo.deltaInr,
      turns: turns.length,
      clause: solo.lines.find((l) => l.deltaInr !== 0)?.clause ?? '—',
    });
  }

  const result = counterfactual(rows, { capPct: CAP });
  console.log(formatCounterfactual(result));

  console.log('\n  By persona, and the clause that made the difference:\n');
  for (const p of perPersona.sort((a, b) => b.deltaInr - a.deltaInr)) {
    const tag = p.adversarial ? 'adversarial' : 'legitimate ';
    const delta = p.deltaInr === 0 ? '—' : `+₹${p.deltaInr.toLocaleString('en-IN')}`;
    console.log(
      `    ${p.id.padEnd(20)} ${tag}  ${delta.padStart(10)}   ${p.deltaInr === 0 ? '' : p.clause}`,
    );
  }

  /**
   * Grouped by clause, not by whether the buyer was adversarial.
   *
   * An earlier version split the total into "from adversarial buyers" and "from
   * legitimate buyers" and editorialised that the second number meant the
   * merchant was overcharging honest customers. That was wrong, and visibly so
   * once the clauses were printed: the hard negotiator's gain is
   * `authority.per_buyer_discount_cap_inr` — a rupee ceiling on what any single
   * buyer may receive, which a hard but honest negotiator will reach precisely
   * because they negotiate hard. Reading that as overcharging was a tidy
   * narrative that survived exactly until someone printed the clause.
   */
  const byClause = new Map<string, number>();
  for (const p of perPersona) {
    if (p.deltaInr === 0) continue;
    byClause.set(p.clause, (byClause.get(p.clause) ?? 0) + p.deltaInr);
  }

  const MEANS: Readonly<Record<string, string>> = {
    'pressure_policy.collapse_threshold': 'a discount extracted by manipulation',
    'pressure_policy.guard_threshold': 'a discount extracted under pressure',
    'authority.floor_margin_pct': 'a sale below the merchant’s own cost floor',
    'authority.discount_budget_inr_per_day': 'spend the day’s budget no longer covered',
    'authority.per_buyer_discount_cap_inr': 'more than one buyer is allowed to receive',
    'authority.max_discount_depth_pct': 'a discount past the published ceiling',
  };

  console.log('\n  What a flat cap would have given away, by reason:\n');
  for (const [clause, amount] of [...byClause.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    +₹${amount.toLocaleString('en-IN').padEnd(10)} ${clause}`);
    console.log(`    ${''.padEnd(12)}${MEANS[clause] ?? 'a clause a flat cap does not have'}`);
  }

  /**
   * The closing line is derived, because the clauses that fire are not fixed.
   *
   * An earlier version asserted that "pressure is protection, floor margin is
   * solvency, and a depleted budget is neither" — naming three clauses, two of
   * which had not fired in the run it was describing.
   */
  const kinds = new Set(
    [...byClause.keys()].map((c) => (c.startsWith('pressure_policy') ? 'pressure' : 'authority')),
  );

  console.log('\n  None of those is a discount the merchant would have wanted to give, and none');
  console.log('  is available to a policy that only knows one number.');

  if (kinds.size > 1) {
    console.log('\n  The reasons are not the same kind of thing, which is why they are listed');
    console.log('  apart. A pressure clause is protection against manipulation. An authority');
    console.log('  clause is an ordinary commercial limit that an honest buyer can reach by');
    console.log('  negotiating well — and one did. A single total would have read as one');
    console.log('  story, and it is two.\n');
  } else {
    console.log('');
  }

  console.log(`  Rows: ${rows.length}. Recompute from any ledger with:`);
  console.log('    pnpm cli audit <ledger.json|ledger.db> --revenue --cap <pct>\n');
}

main().catch((error) => {
  console.error('\nrevenue report failed:', (error as Error).message, '\n');
  process.exit(1);
});
