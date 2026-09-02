/**
 * The audit ledger.
 *
 * Append-only and hash-chained: every row carries the hash of the row before it,
 * so the chain is tamper-evident. That upgrades "show the audit trail" into
 * "prove the audit trail was not edited", which is a meaningfully different
 * claim. A ledger anyone can rewrite after the fact explains nothing — it is a
 * log file with good intentions.
 *
 * Every money action produces a row, and so does every refusal and every
 * pressure incident. Refusals matter as much as approvals: a trail showing only
 * what the agent did, and never what it declined to do, cannot demonstrate that
 * the envelope was ever binding.
 *
 * Rows are chained over their canonical JSON, so the chain is verifiable by
 * anyone who can canonicalize — the `counterparty audit --verify-chain` command
 * recomputes it from scratch rather than trusting a stored value.
 */

import { createHash } from 'node:crypto';
import { canonicalize, type JsonObject } from '../crypto/canonical';
import { formatInr, formatPct, rupeesToPaise } from '../money';
import type { ClausePath } from '../mandate/schema';
import type { PostAuthReason, SettlementPath } from '../gate/offer';

/**
 * The twelve money actions from §8, plus the two kinds of row that are not
 * money actions but without which the trail is not evidence of anything.
 */
export const MONEY_ACTIONS = [
  'quote_issued',
  'discount_conceded',
  'bundle_priced',
  'authorize',
  'settle_at_conceded',
  'capture_full',
  'deliberate_lapse',
  'partial_refund',
  'full_refund',
  'subscription_created',
  'subscription_paused',
  'campaign_offer_issued',
] as const;

export type MoneyAction = (typeof MONEY_ACTIONS)[number];

export const AUDIT_ACTIONS = [...MONEY_ACTIONS, 'quote_refused', 'pressure_incident'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntry {
  readonly at: string;
  readonly action: AuditAction;
  readonly session_id: string;
  readonly envelope_id: string;
  readonly outcome: 'signed' | 'refused' | 'executed' | 'failed' | 'logged';
  /**
   * The clause that authorized this action, or the clause that refused it.
   * Every row names one. A row with nothing to cite is a row that cannot
   * explain itself.
   */
  readonly authorized_by: ClausePath;
  /** What that clause actually said, for the "(15)" in the rendered row. */
  readonly clause_value?: string | number;
  readonly agent_rationale: string;
  readonly pressure_score: number;
  readonly budget_remaining_inr: number;
  readonly budget_limit_inr: number;

  readonly offer_id?: string;
  readonly buyer_id?: string;
  readonly amount_inr?: number;
  readonly list_inr?: number;
  readonly depth_pct?: number;
  readonly settlement_path?: SettlementPath;
  readonly post_auth_reason?: PostAuthReason;
  /** Razorpay object ids, when the action touched the rails. */
  readonly rails?: readonly string[];
  /** The gate signature over the offer this row records, when there is one. */
  readonly signature?: string;
  /** For pressure incidents: the offending strings, verbatim. */
  readonly evidence?: readonly string[];
}

export interface AuditRow extends AuditEntry {
  readonly seq: number;
  readonly prev_hash: string;
  readonly hash: string;
}

export interface AuditLedger {
  readonly rows: readonly AuditRow[];
}

export function openLedger(): AuditLedger {
  return { rows: [] };
}

/**
 * Hash of a row over its canonical JSON, excluding the `hash` field itself.
 *
 * `prev_hash` IS included, which is what links the chain: changing any earlier
 * row changes its hash, which changes the next row's `prev_hash`, which changes
 * that row's hash, and so on to the end.
 */
export function hashRow(row: Omit<AuditRow, 'hash'>): string {
  return createHash('sha256').update(canonicalize(row as unknown as JsonObject)).digest('hex');
}

export function append(ledger: AuditLedger, entry: AuditEntry): AuditLedger {
  const previous = ledger.rows.at(-1);

  /**
   * Strip any chain fields the caller carried in.
   *
   * Passing a whole existing row back to `append` is a natural thing to do —
   * replaying a session, migrating a store, rebuilding after a repair — and if
   * a stale `hash` rode along inside the hashed content, the resulting row
   * would hash over a field that `verifyChain` excludes. It would append
   * cleanly and then fail verification forever, with nothing in the row to
   * indicate why. The chain fields belong to the ledger, not to the entry.
   */
  const { seq: _seq, prev_hash: _prev, hash: _hash, ...content } = entry as AuditEntry &
    Partial<Pick<AuditRow, 'seq' | 'prev_hash' | 'hash'>>;

  const unhashed: Omit<AuditRow, 'hash'> = {
    ...content,
    seq: (previous?.seq ?? 0) + 1,
    prev_hash: previous?.hash ?? GENESIS_HASH,
  };
  return { rows: [...ledger.rows, { ...unhashed, hash: hashRow(unhashed) }] };
}

/**
 * Somewhere rows can be appended to and read back from.
 *
 * Exists so the session does not care whether its ledger is an array in memory
 * or a table on disk. `append` above is the pure function and stays pure; this
 * is the mutable handle a long-running session holds.
 *
 * The interface is deliberately tiny and deliberately has no `update` and no
 * `delete`. A ledger that can be revised is not evidence, and leaving those off
 * the interface means no caller can even ask.
 */
export interface LedgerWriter {
  append(entry: AuditEntry): AuditRow;
  readonly rows: readonly AuditRow[];
}

/** The default: rows in an array, gone when the process is. */
export class MemoryLedger implements LedgerWriter {
  private state: AuditLedger = openLedger();

  append(entry: AuditEntry): AuditRow {
    this.state = append(this.state, entry);
    const written = this.state.rows.at(-1);
    if (written === undefined) {
      // Unreachable: append always returns a ledger one row longer.
      throw new Error('append produced no row');
    }
    return written;
  }

  get rows(): readonly AuditRow[] {
    return this.state.rows;
  }
}

export type ChainVerification =
  | { readonly ok: true; readonly rows: number }
  | {
      readonly ok: false;
      readonly seq: number;
      readonly problem: 'broken_link' | 'bad_hash' | 'out_of_order';
      readonly detail: string;
    };

/**
 * Recompute the whole chain from scratch.
 *
 * Deliberately does not trust any stored hash: it rebuilds each row's hash from
 * the row's own content and checks both that the hash matches and that the link
 * to the previous row is intact. Trusting the stored hash would verify only that
 * the ledger is internally consistent with itself, which a rewriter would also
 * have arranged.
 */
export function verifyChain(rows: readonly AuditRow[]): ChainVerification {
  let expectedPrev = GENESIS_HASH;

  for (const [index, row] of rows.entries()) {
    if (row.seq !== index + 1) {
      return {
        ok: false,
        seq: row.seq,
        problem: 'out_of_order',
        detail: `row at position ${index + 1} claims sequence ${row.seq}`,
      };
    }
    if (row.prev_hash !== expectedPrev) {
      return {
        ok: false,
        seq: row.seq,
        problem: 'broken_link',
        detail:
          `row ${row.seq} points at ${short(row.prev_hash)} but the previous row hashes to ${short(expectedPrev)} ` +
          '— a row was altered, inserted or removed before this point',
      };
    }

    const { hash: stored, ...content } = row;
    const recomputed = hashRow(content);
    if (recomputed !== stored) {
      return {
        ok: false,
        seq: row.seq,
        problem: 'bad_hash',
        detail: `row ${row.seq} stores ${short(stored)} but its content hashes to ${short(recomputed)} — the row was edited`,
      };
    }

    expectedPrev = stored;
  }

  return { ok: true, rows: rows.length };
}

/**
 * Render a row in the §9 format: machine-parseable, human-readable, one row.
 *
 * ```
 * [2026-08-24T14:22:07Z] action=settle_at_conceded  offer=off_XXXX
 *   amount=₹4,240 (list ₹4,990, depth 15.0%)
 *   authorized_by=clause:authority.max_discount_depth_pct (15)
 *   budget_remaining=₹11,200 / ₹40,000
 *   agent_rationale="buyer verified bulk intent, 3-unit bundle, within floor margin"
 *   pressure_score=0.12
 *   signature=sig_XXXX
 * ```
 */
export function formatRow(row: AuditRow): string {
  const lines: string[] = [];
  const header = [`[${row.at}]`, `action=${row.action}`];
  if (row.offer_id !== undefined) header.push(`offer=${row.offer_id}`);
  if (row.outcome === 'refused') header.push('REFUSED');
  lines.push(header.join('  '));

  if (row.amount_inr !== undefined) {
    const parts: string[] = [];
    if (row.list_inr !== undefined) parts.push(`list ${formatInr(rupeesToPaise(row.list_inr))}`);
    if (row.depth_pct !== undefined) parts.push(`depth ${formatPct(row.depth_pct)}`);
    const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    lines.push(`  amount=${formatInr(rupeesToPaise(row.amount_inr))}${suffix}`);
  }

  if (row.settlement_path !== undefined) {
    const reason = row.post_auth_reason !== undefined ? `  reason=${row.post_auth_reason}` : '';
    lines.push(`  settlement_path=${row.settlement_path}${reason}`);
  }

  const clauseValue = row.clause_value !== undefined ? ` (${row.clause_value})` : '';
  lines.push(`  authorized_by=clause:${row.authorized_by}${clauseValue}`);

  if (row.rails !== undefined && row.rails.length > 0) {
    lines.push(`  rails=[${row.rails.join(', ')}]`);
  }

  lines.push(
    `  budget_remaining=${formatInr(rupeesToPaise(row.budget_remaining_inr))} / ` +
      `${formatInr(rupeesToPaise(row.budget_limit_inr))}`,
  );
  lines.push(`  agent_rationale="${row.agent_rationale.replace(/"/g, "'")}"`);
  lines.push(`  pressure_score=${row.pressure_score.toFixed(2)}`);

  if (row.evidence !== undefined && row.evidence.length > 0) {
    for (const each of row.evidence) {
      lines.push(`  evidence="${each.replace(/"/g, "'")}"`);
    }
  }

  if (row.signature !== undefined) {
    lines.push(`  signature=${short(row.signature)}`);
  }

  lines.push(`  hash=${short(row.hash)}  prev=${short(row.prev_hash)}`);

  return lines.join('\n');
}

export function formatLedger(ledger: AuditLedger): string {
  return ledger.rows.map(formatRow).join('\n\n');
}

function short(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 16)}…`;
}
