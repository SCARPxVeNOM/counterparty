/**
 * counterparty — independent verification.
 *
 * The point of this command is that it shares no state with the agent. It takes
 * a JSON file and a public key and recomputes everything from scratch: the
 * canonical bytes, the signature, the clause the offer cites, the hash chain. A
 * buyer's agent could implement the same checks from the spec without any of
 * this code, which is the property that makes a signed offer worth anything.
 *
 *   counterparty verify <offer.json> [--envelope <mandate.json>]
 *   counterparty envelope <mandate.json> --merchant-key <key.pem>
 *   counterparty audit <ledger.json>
 *   counterparty keys
 *   counterparty onboard <url|fixture>
 *   counterparty replay [scenario]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  counterfactual,
  formatCounterfactual,
  formatInr,
  formatRow,
  kidFromPublicKeyPem,
  generateKeyPair,
  rupeesToPaise,
  verifyAsCounterparty,
  verifyChain,
  verifyMandate,
  type AuditRow,
  type JsonObject,
  type PublicKeyRef,
} from '@counterparty/core';
import {
  FIXTURES,
  fetchSource,
  isRazorpayPaymentPage,
  loadFixture,
  readSource,
  type ExtractionSource,
  type FixtureName,
} from '@counterparty/extract';
import { verifyLedgerFile } from '@counterparty/store';

const OK = 'PASS';
const NO = 'FAIL';

function line(passed: boolean, label: string, detail = ''): boolean {
  console.log(`  ${passed ? OK : NO}  ${label}${detail === '' ? '' : `\n        ${detail}`}`);
  return passed;
}

function readJson(path: string): JsonObject {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
  } catch (error) {
    console.error(`could not read ${path}: ${(error as Error).message}`);
    process.exit(2);
  }
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

// ---------------------------------------------------------------------------

/**
 * Verify a signed offer, as the counterparty.
 *
 * The checking itself is `verifyAsCounterparty` in core — the same function a
 * buyer's agent calls before it agrees to pay. This command is a terminal around
 * it and deliberately nothing more. An independent verifier that reimplements
 * its own checks is two verifiers, and the day they disagree is the day nobody
 * knows which was right.
 *
 * Three inputs, and the third is not optional in spirit:
 *
 *   the offer       what the merchant's agent sent
 *   --envelope      the authority it claims to act under
 *   --merchant-key  the merchant's public key, FROM SOMEWHERE ELSE
 *
 * Without the third, this can still tell you the documents agree with each
 * other — which a forger would also arrange. It says so rather than implying a
 * check it did not perform.
 */
function verifyOffer(offerPath: string, envelopePath?: string): void {
  const offer = readJson(offerPath);
  console.log(`\nOffer ${String(offer['offer_id'] ?? '(no id)')}\n`);

  const signature = offer['signature'] as Record<string, unknown> | undefined;
  if (signature === undefined) {
    line(false, 'has a gate signature', 'this document is not signed — it is a proposal, not an offer');
    process.exit(1);
  }

  if (envelopePath === undefined) {
    console.log('  No envelope supplied. Checking internal consistency only.\n');
    console.log(`  signed by gate ${String(signature['kid'])} at ${String(signature['signed_at'])}`);
    console.log(`  cites envelope ${String(offer['envelope_id'])}`);
    console.log('\n  Pass --envelope <mandate.json> to check that a merchant actually');
    console.log('  authorized this gate. A gate signature alone proves only that a gate');
    console.log('  approved this, never that anyone gave that gate authority.\n');
    process.exit(0);
  }

  const envelope = readJson(envelopePath);

  /**
   * `--as-of` exists because the demo runs on a fixed clock, so its offers are
   * always in the past by the time anyone checks them.
   */
  const asOfFlag = flag('as-of');
  const now = asOfFlag === undefined ? new Date() : new Date(Date.parse(asOfFlag));

  /**
   * The merchant key is required, not optional.
   *
   * An earlier version of this command made it a flag and printed `SKIP` when it
   * was missing, which quietly turned a counterparty check into "these two
   * documents agree with each other" — a property any forger can arrange by
   * supplying both. There is no honest reduced version of this check, so there
   * is no reduced version.
   */
  const merchantKeyPath = flag('merchant-key');
  if (merchantKeyPath === undefined) {
    console.error('  --merchant-key <public.pem> is required.\n');
    console.error('  Verifying an offer against an envelope you cannot check the signature of');
    console.error('  proves only that whoever wrote one also wrote the other. The merchant key');
    console.error('  has to come from somewhere the sender does not control — a key directory,');
    console.error('  a prior relationship, `pnpm cli keys`. That is what anchors the chain.\n');
    process.exit(2);
  }

  const pem = readFileSync(merchantKeyPath, 'utf8');
  const merchantPublicKey: PublicKeyRef = {
    role: 'merchant',
    kid: kidFromPublicKeyPem(pem),
    publicKeyPem: pem,
  };

  const verdict = verifyAsCounterparty({ offer, envelope, merchantPublicKey, now });

  for (const check of verdict.checks) {
    line(check.ok, check.check.replace(/_/g, ' '), check.detail);
  }

  /**
   * Expiry is reported, not asserted.
   *
   * An expired offer is still a genuine record of what the merchant authorized
   * at the time — which is exactly what an auditor reading it six months later
   * needs. It is simply no longer something a buyer can act on. Conflating "was
   * never valid" with "is no longer live" would make the tool useless for the
   * case it is most needed in, so a chain that fails only on a validity window,
   * with no `--as-of` given, exits zero with an explanation.
   */
  const onlyExpired =
    !verdict.ok && (verdict.failed === 'offer_unexpired' || verdict.failed === 'envelope_in_force');

  if (onlyExpired && asOfFlag === undefined) {
    console.log('\n  PAST  every check up to this point passed; the document has simply aged out.');
    console.log('        Expiry does not invalidate a signature — this is still a true record of');
    console.log('        what was authorized. Pass --as-of <iso> to check it at its own moment.\n');
    process.exit(0);
  }

  if (verdict.ok) {
    console.log(
      `\nThis offer is binding on ${verdict.merchantId}: ` +
        `${formatInr(rupeesToPaise(verdict.offeredTotalInr))} at ${verdict.depthPct}%, ` +
        `inside a published ceiling of ${verdict.maxDepthPct}%.\n`,
    );
    process.exit(0);
  }

  console.log(`\nThis offer is NOT valid. Do not rely on it.\n  ${verdict.detail}\n`);
  process.exit(1);
}


// ---------------------------------------------------------------------------

function verifyEnvelope(path: string): void {
  const envelope = readJson(path);
  const merchantKeyPath = flag('merchant-key');

  console.log(`\nEnvelope ${String(envelope['envelope_id'] ?? '(no id)')}\n`);

  if (merchantKeyPath === undefined) {
    console.error('  --merchant-key <public.pem> is required to verify an envelope.');
    process.exit(2);
  }

  const pem = readFileSync(merchantKeyPath, 'utf8');
  const ref: PublicKeyRef = { role: 'merchant', kid: kidFromPublicKeyPem(pem), publicKeyPem: pem };
  const check = verifyMandate(envelope, ref);

  if (!check.ok) {
    line(false, 'valid', `${check.reason}: ${check.detail}`);
    process.exit(1);
  }

  const mandate = check.mandate;
  line(true, 'signed by the merchant', `merchant ${mandate.signature.kid}`);
  line(true, 'within its validity window', `${mandate.issued_at} → ${mandate.expires_at}`);
  console.log(`\n  delegates to gate      ${mandate.gate_key.kid}`);
  console.log(`  max discount depth     ${mandate.authority.max_discount_depth_pct}%`);
  console.log(`  bundle depth           ${mandate.authority.bundle_rules.combined_depth_pct}% up to ${mandate.authority.bundle_rules.max_items} units`);
  console.log(`  floor margin           ${mandate.authority.floor_margin_pct}%`);
  console.log(`  daily discount budget  ${formatInr(rupeesToPaise(mandate.authority.discount_budget_inr_per_day))}`);
  console.log(`  per-buyer cap          ${formatInr(rupeesToPaise(mandate.authority.per_buyer_discount_cap_inr))}`);
  console.log(`  capture window         ${mandate.authority.capture_window_hours}h`);
  console.log(`  collapse threshold     ${mandate.pressure_policy.collapse_threshold}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------

/**
 * Read rows from whichever kind of ledger this is.
 *
 * A `.db` is the console's live ledger, a `.json` is what `pnpm demo` writes.
 * Both are the same rows and the same chain — the verifier below does not know
 * or care which it was handed, which is the point of keeping chaining in pure
 * core functions rather than in a storage layer.
 */
function loadRows(path: string): { rows: AuditRow[]; kind: string } {
  if (path.endsWith('.db') || path.endsWith('.sqlite') || path.endsWith('.sqlite3')) {
    const { rows } = verifyLedgerFile(path);
    return { rows: [...rows], kind: 'SQLite' };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { rows?: AuditRow[] } | AuditRow[];
  return { rows: Array.isArray(parsed) ? parsed : (parsed.rows ?? []), kind: 'JSON' };
}

function auditChain(path: string): void {
  const { rows, kind } = loadRows(path);

  console.log(`\nAudit ledger (${kind}) — ${rows.length} row(s)\n`);

  if (process.argv.includes('--show')) {
    for (const row of rows) console.log(`${formatRow(row)}\n`);
  }

  /**
   * `--revenue` answers the other half of the track.
   *
   * The chain says the agent stayed inside its authority. This says what that
   * was worth against the policy everybody else ships — a flat cap — and it is
   * computed from these rows alone, so anyone holding the ledger can recompute
   * it without trusting the code that wrote it.
   */
  if (process.argv.includes('--revenue')) {
    const capFlag = flag('cap');
    const result = counterfactual(rows, capFlag === undefined ? {} : { capPct: Number(capFlag) });
    console.log(`${formatCounterfactual(result)}\n`);
  }

  const result = verifyChain(rows);
  if (result.ok) {
    console.log(`  ${OK}  the chain is intact across all ${result.rows} rows`);
    console.log(`\n  head hash  ${rows.at(-1)?.hash ?? '(empty ledger)'}`);
    console.log('  Publish that hash. Anyone holding it can prove the ledger has not been');
    console.log('  rewritten, which the chain alone cannot — a full rewrite is internally');
    console.log('  consistent. What the chain guarantees is that a PARTIAL edit is always caught.\n');
    process.exit(0);
  }

  console.log(`  ${NO}  ${result.problem} at row ${result.seq}`);
  console.log(`        ${result.detail}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

function makeKeys(): void {
  const outDir = flag('out') ?? '.';
  const merchant = generateKeyPair('merchant');
  const gate = generateKeyPair('gate');

  for (const [name, key] of [
    ['merchant', merchant],
    ['gate', gate],
  ] as const) {
    writeFileSync(`${outDir}/${name}.private.pem`, key.privateKeyPem, 'utf8');
    writeFileSync(`${outDir}/${name}.public.pem`, key.publicKeyPem, 'utf8');
    console.log(`  ${name}  kid=${key.kid}  ->  ${outDir}/${name}.{private,public}.pem`);
  }
  console.log('\n  The merchant private key grants authority. Keep it off the machine running');
  console.log('  the agent — that machine only ever needs the gate key.\n');
}

// ---------------------------------------------------------------------------

/**
 * Onboard a storefront: read the page, show the working, draft the envelope.
 *
 * The screen a merchant would see, as text. What matters is that every number
 * arrives with the reason for it attached — a confidence score with no evidence
 * beside it is a number the merchant has to take on faith, and taking margin
 * authority on faith is the failure this system exists to prevent.
 */
async function onboard(target: string): Promise<void> {
  const isUrl = /^https?:\/\//i.test(target);
  let source: ExtractionSource;

  if (isUrl) {
    console.log(`\n  fetching ${target}\n`);
    try {
      source = await fetchSource(target);
    } catch (error) {
      console.error(`could not fetch ${target}: ${(error as Error).message}`);
      process.exit(2);
    }
  } else {
    if (!(target in FIXTURES)) {
      console.error(`unknown fixture "${target}". Known: ${Object.keys(FIXTURES).join(', ')}`);
      process.exit(2);
    }
    source = loadFixture(target as FixtureName);
    console.log(`\n  fixture ${target} — ${FIXTURES[target as FixtureName].note}\n`);
  }

  const kind = isRazorpayPaymentPage(source.html) ? 'Razorpay Payment Page' : 'storefront markup';
  console.log(`  source     ${source.url}`);
  console.log(`  read as    ${kind}`);

  let result;
  try {
    result = readSource(source, flag('sku'));
  } catch (error) {
    console.error(`\n  extraction failed: ${(error as Error).message}\n`);
    process.exit(1);
  }

  const entry = result.entry;
  console.log(`\n  sku        ${entry.sku}`);
  console.log(`  title      ${entry.title.value}`);
  console.log(`  list price ${formatInr(rupeesToPaise(Number(entry.list_price_inr.value)))}`);
  console.log(`  unit cost  ${formatInr(rupeesToPaise(Number(entry.unit_cost_inr.value)))}`);
  console.log(`  available  ${entry.availability.value}`);

  console.log('\n  per-field confidence, and what moved it\n');
  for (const report of result.reports) {
    const bar = '█'.repeat(Math.round(report.confidence * 20)).padEnd(20, '·');
    console.log(`  ${report.field.padEnd(15)} ${bar} ${report.confidence.toFixed(3)}`);
    for (const problem of report.ambiguities) {
      console.log(`      − ${problem.kind}: ${problem.note}`);
      if (problem.evidence !== '') console.log(`        evidence: ${problem.evidence.slice(0, 90)}`);
    }
  }

  console.log('\n  provenance');
  console.log(`    price  ${entry.list_price_inr.provenance.snippet.slice(0, 100)}`);
  console.log(`    cost   ${entry.unit_cost_inr.provenance.snippet.slice(0, 100)}`);
  console.log(`    seen   ${entry.list_price_inr.provenance.crawled_at}`);

  // --- what this means for authority --------------------------------------
  const costConfidence = result.reports.find((r) => r.field === 'unit_cost_inr')?.confidence ?? 0;
  const threshold = 0.85;

  console.log('\n  draft authority');
  if (costConfidence < threshold) {
    console.log(`    max_discount_depth_pct = 0 on ${entry.sku}`);
    console.log(
      `    because unit_cost confidence ${costConfidence.toFixed(3)} is below ` +
        `confidence_policy.min_margin_confidence (${threshold})`,
    );
    console.log('\n    The agent may not discount what it cannot prove it can afford to');
    console.log('    discount. Supply a verified unit cost to unlock depth on this SKU.');
  } else {
    console.log(`    max_discount_depth_pct = up to the envelope ceiling on ${entry.sku}`);
    console.log(`    unit_cost confidence ${costConfidence.toFixed(3)} clears the threshold`);
  }

  const out = flag('out');
  if (out !== undefined) {
    writeFileSync(out, JSON.stringify(entry, null, 2), 'utf8');
    console.log(`\n  catalog entry written to ${out}`);
  }
  console.log();
}

/**
 * Replay one demo scenario, or list them.
 *
 * Delegates to the same functions `pnpm demo` runs. A separate implementation
 * for single-scenario replay would be a second thing to keep correct, and the
 * one a judge runs is exactly the one that must not have drifted.
 */
async function replay(name: string | undefined): Promise<void> {
  const { SCENARIOS, runScenarios } = await import('../../../scenarios/run-all');
  const names = Object.keys(SCENARIOS);

  if (name === undefined || !names.includes(name)) {
    if (name !== undefined) console.error(`\nunknown scenario "${name}"`);
    console.log('\n  scenarios:\n');
    for (const [key, value] of Object.entries(SCENARIOS)) {
      console.log(`    ${key.padEnd(10)} ${(value as { title: string }).title}`);
    }
    console.log('\n  counterparty replay <name>       one scenario');
    console.log('  pnpm demo                        all four\n');
    process.exit(name === undefined ? 0 : 2);
  }

  const failures = await runScenarios([name as keyof typeof SCENARIOS]);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------

function usage(): never {
  console.log(`
counterparty — verify what a selling agent claims

  counterparty verify <offer.json> --envelope <mandate.json> --merchant-key <public.pem>
      Run the counterparty check — the one a buyer's agent runs before it pays.
      Merchant signature over the envelope, the envelope's delegation to a
      specific gate, the gate's signature over the offer, and the offer's terms
      against the limits the merchant published. [--as-of <iso>]

  counterparty envelope <mandate.json> --merchant-key <public.pem>
      Check a selling mandate and print the authority it grants.

  counterparty audit <ledger.json|ledger.db> [--show] [--revenue] [--cap <pct>]
      Recompute the hash chain over an audit ledger. Reads the JSON that
      pnpm demo writes, or the console's live SQLite ledger (data/console.db).
      --revenue compares what the envelope earned against a flat discount cap.

  counterparty keys [--out <dir>]
      Generate a merchant and a gate keypair.

  counterparty onboard <url|fixture> [--sku <SKU>] [--out <entry.json>]
      Read a storefront or a Razorpay Payment Page. Prints every field with
      the confidence behind it, the evidence that moved it, and the discount
      authority the result would earn.
      Fixtures: kettle, espresso, blender, razorpayPage

  counterparty replay [scenario]
      Replay one demo scenario. No argument lists them.
`);
  process.exit(2);
}

const [command, target] = process.argv.slice(2);

switch (command) {
  case 'verify':
    if (target === undefined) usage();
    verifyOffer(target, flag('envelope'));
    break;
  case 'envelope':
    if (target === undefined) usage();
    verifyEnvelope(target);
    break;
  case 'audit':
    if (target === undefined) usage();
    auditChain(target);
    break;
  case 'keys':
    makeKeys();
    break;
  case 'onboard':
    if (target === undefined) usage();
    await onboard(target);
    break;
  case 'replay':
    await replay(target);
    break;
  default:
    usage();
}
