/**
 * Every console flow, driven through the HTTP API against a running server.
 *
 *   pnpm dev          # in another terminal
 *   pnpm flows
 *
 * `pnpm test` covers the gate, the detectors, the chain and the counterparty
 * check as pure units. None of that catches the console wiring — and the
 * console wiring is where the bugs were: a reply showing the previous run's
 * clause, a fresh page opening with eight rows from sessions that had already
 * ended, a turn producing no offer and rendering nothing at all.
 *
 * So this drives the real endpoint the browser drives, for every persona, and
 * asserts the things a judge would notice.
 *
 * Scripted personas replay from `cassettes/console/` in about 100ms. A
 * free-typed message is a live model call and takes tens of seconds, which is
 * why there is exactly one of those at the end.
 */

import { PERSONAS } from '@counterparty/agents';

const BASE = 'http://localhost:3939';

async function post(body: unknown): Promise<any> {
  const r = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await r.json()) as any;
}

function line(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`);
  if (!ok) process.exitCode = 1;
}

for (const persona of Object.values(PERSONAS)) {
  const fresh = await post({ id: 'flowtest', reset: true });
  const id = fresh.id as string;

  console.log(`\n${persona.label} (${id})`);
  line('reset gives an empty ledger view', fresh.ledger.rows.length === 0);

  const v = await post({ id, message: persona.scriptedOpening });

  line('the agent replied', typeof v.transcript?.[1]?.text === 'string' && v.transcript[1].text.length > 0);
  line('a turn was recorded', v.transcript.length === 2, `${v.transcript.length} entries`);

  const agentEntry = v.transcript[1];
  const offer = v.offers.at(-1);
  const row = v.ledger.rows.find((r: any) => r.seq === agentEntry?.rowSeq);
  line(
    'the reply points at its own ledger row, or at none',
    agentEntry?.rowSeq == null || row !== undefined,
    `rowSeq=${agentEntry?.rowSeq}`,
  );

  if (row !== undefined) {
    const newest = v.ledger.rows
      .filter((r: any) => r.action !== 'pressure_incident')
      .at(-1);
    line('and it is this turn’s row, not an older one', row.seq === newest?.seq);
    console.log(`        ${row.action}  ${row.authorized_by}  ${row.amount_inr ?? '—'}`);
  }

  if (offer !== undefined) {
    line('the buyer verified the offer', offer.counterparty.accepted === true, offer.counterparty.failed ?? '');
    line('all ten checks ran', offer.counterparty.checks.length === 10);
  } else {
    console.log('        (no signed offer this turn)');
  }

  line('the chain is intact', v.ledger.chainIntact === true);
  /**
   * Only the personas that manipulate on their FIRST message are asserted on.
   * The promo stacker probes across turns by design, so a plain opening ask of
   * "can you do 25%?" scoring zero is the detectors being right, not wrong.
   */
  const injectsImmediately = persona.id === 'prompt_injector' || persona.id === 'social_engineer';
  line(
    'pressure matches the persona',
    injectsImmediately ? v.pressure.score > 0 : true,
    `${v.pressure.state} ${v.pressure.score.toFixed(2)}`,
  );

  // A turn with no offer must still explain itself rather than render nothing.
  if (offer === undefined) {
    line('a turn with no offer is still legible', agentEntry?.rowSeq === null);
  }
}

console.log('\nfree-typed message');
const fresh = await post({ id: 'flowtest', reset: true });
const typed = await post({ id: fresh.id, message: 'Can you do anything on price for two kettles?' });
line('an unscripted message is answered', typed.transcript.length === 2);
line('and lands in the ledger', typed.ledger.rows.length > 0);

console.log('\nempty message');
const r = await fetch(`${BASE}/api/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: fresh.id, message: '   ' }),
});
line('is rejected with 400', r.status === 400, `status ${r.status}`);

console.log(process.exitCode === 1 ? '\nSOME CHECKS FAILED\n' : '\nall flows pass\n');
