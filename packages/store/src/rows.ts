/**
 * Turning an `AuditRow` into columns and back without changing it.
 *
 * "Without changing it" is the entire requirement, and it is stricter than it
 * sounds. Every row's hash is taken over the canonical JSON of the row, so a
 * field that leaves as absent and comes back as `null` produces different bytes,
 * a different hash, and a chain that fails verification the first time the file
 * is reopened — reported as tampering, on a ledger nobody touched.
 *
 * So the reader below builds its object by *omission*: a NULL column contributes
 * no key at all. That is why it reads as a pile of conditional spreads rather
 * than a clean object literal.
 */

import type { AuditAction, AuditRow, ClausePath } from '@counterparty/core';
import type { PostAuthReason, SettlementPath } from '@counterparty/core';

/** What better-sqlite3 hands back: NULL becomes null, never undefined. */
export interface StoredRow {
  readonly seq: number;
  readonly at: string;
  readonly action: string;
  readonly session_id: string;
  readonly envelope_id: string;
  readonly outcome: string;
  readonly authorized_by: string;
  readonly clause_value: string | null;
  readonly agent_rationale: string;
  readonly pressure_score: number;
  readonly budget_remaining_inr: number;
  readonly budget_limit_inr: number;
  readonly offer_id: string | null;
  readonly buyer_id: string | null;
  readonly amount_inr: number | null;
  readonly list_inr: number | null;
  readonly depth_pct: number | null;
  readonly proposed_depth_pct: number | null;
  readonly ceiling_pct: number | null;
  readonly settlement_path: string | null;
  readonly post_auth_reason: string | null;
  readonly rails: string | null;
  readonly signature: string | null;
  readonly evidence: string | null;
  readonly prev_hash: string;
  readonly hash: string;
}

/** SQLite binds undefined as a missing parameter and throws; NULL is explicit. */
const orNull = <T>(value: T | undefined): T | null => (value === undefined ? null : value);

export function toColumns(row: AuditRow): Record<string, string | number | null> {
  return {
    seq: row.seq,
    at: row.at,
    action: row.action,
    session_id: row.session_id,
    envelope_id: row.envelope_id,
    outcome: row.outcome,
    authorized_by: row.authorized_by,
    // JSON, not the raw value: `clause_value` is string | number, and a column
    // typed either way would silently flatten 15 into '15' or '15' into 15.
    // Both survive a round trip through JSON; neither survives TEXT.
    clause_value: row.clause_value === undefined ? null : JSON.stringify(row.clause_value),
    agent_rationale: row.agent_rationale,
    pressure_score: row.pressure_score,
    budget_remaining_inr: row.budget_remaining_inr,
    budget_limit_inr: row.budget_limit_inr,
    offer_id: orNull(row.offer_id),
    buyer_id: orNull(row.buyer_id),
    amount_inr: orNull(row.amount_inr),
    list_inr: orNull(row.list_inr),
    depth_pct: orNull(row.depth_pct),
    proposed_depth_pct: orNull(row.proposed_depth_pct),
    ceiling_pct: orNull(row.ceiling_pct),
    settlement_path: orNull(row.settlement_path),
    post_auth_reason: orNull(row.post_auth_reason),
    rails: row.rails === undefined ? null : JSON.stringify(row.rails),
    signature: orNull(row.signature),
    evidence: row.evidence === undefined ? null : JSON.stringify(row.evidence),
    prev_hash: row.prev_hash,
    hash: row.hash,
  };
}

export function fromColumns(stored: StoredRow): AuditRow {
  return {
    seq: stored.seq,
    at: stored.at,
    action: stored.action as AuditAction,
    session_id: stored.session_id,
    envelope_id: stored.envelope_id,
    outcome: stored.outcome as AuditRow['outcome'],
    authorized_by: stored.authorized_by as ClausePath,
    ...(stored.clause_value === null
      ? {}
      : { clause_value: JSON.parse(stored.clause_value) as string | number }),
    agent_rationale: stored.agent_rationale,
    pressure_score: stored.pressure_score,
    budget_remaining_inr: stored.budget_remaining_inr,
    budget_limit_inr: stored.budget_limit_inr,
    ...(stored.offer_id === null ? {} : { offer_id: stored.offer_id }),
    ...(stored.buyer_id === null ? {} : { buyer_id: stored.buyer_id }),
    ...(stored.amount_inr === null ? {} : { amount_inr: stored.amount_inr }),
    ...(stored.list_inr === null ? {} : { list_inr: stored.list_inr }),
    ...(stored.depth_pct === null ? {} : { depth_pct: stored.depth_pct }),
    // Absent on every row written before this column existed, and absent is
    // exactly what it must come back as — see ADDED_COLUMNS in schema.ts.
    ...(stored.proposed_depth_pct === null
      ? {}
      : { proposed_depth_pct: stored.proposed_depth_pct }),
    ...(stored.ceiling_pct === null ? {} : { ceiling_pct: stored.ceiling_pct }),
    ...(stored.settlement_path === null
      ? {}
      : { settlement_path: stored.settlement_path as SettlementPath }),
    ...(stored.post_auth_reason === null
      ? {}
      : { post_auth_reason: stored.post_auth_reason as PostAuthReason }),
    ...(stored.rails === null ? {} : { rails: JSON.parse(stored.rails) as readonly string[] }),
    ...(stored.signature === null ? {} : { signature: stored.signature }),
    ...(stored.evidence === null
      ? {}
      : { evidence: JSON.parse(stored.evidence) as readonly string[] }),
    prev_hash: stored.prev_hash,
    hash: stored.hash,
  };
}
