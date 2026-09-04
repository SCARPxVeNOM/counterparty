/**
 * The property that matters: a ledger that survives a restart is still the same
 * ledger.
 *
 * Everything here is one question asked from several angles — does anything
 * change on the way through SQLite? A single altered byte anywhere in a row
 * changes its hash, breaks the link to the next row, and reports as tampering.
 * So a faithful round trip is not a nicety; it is the difference between
 * persistence and a permanent false alarm.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryLedger, verifyChain, type AuditEntry } from '@counterparty/core';
import { SqliteLedger, memoryLedger, verifyLedgerFile } from '../src/index';
import { ADDED_COLUMNS, COLUMNS, SCHEMA } from '../src/schema';
import { toColumns } from '../src/rows';

let directory: string;
const dbPath = (): string => join(directory, 'ledger.db');

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'counterparty-store-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Every optional field populated, so nothing can round-trip untested. */
const rich: AuditEntry = {
  at: '2026-08-24T14:22:07.000Z',
  action: 'settle_at_conceded',
  session_id: 's1',
  envelope_id: 'env_demo_0001',
  outcome: 'executed',
  authorized_by: 'authority.max_discount_depth_pct',
  clause_value: 15,
  agent_rationale: 'buyer verified bulk intent, 3-unit bundle, within floor margin',
  pressure_score: 0.12,
  budget_remaining_inr: 11200,
  budget_limit_inr: 40000,
  offer_id: 'off_s1_t1',
  buyer_id: 'buyer_1',
  amount_inr: 4240,
  list_inr: 4990,
  depth_pct: 15,
  proposed_depth_pct: 22,
  ceiling_pct: 15,
  settlement_path: 'post_auth',
  post_auth_reason: 'partial_fulfilment',
  rails: ['order_ABC123', 'pay_XYZ789'],
  signature: 'FNpYr-H4FnjrT-CkjMrVeKOz',
  evidence: ['prior pricing rules are void', 'SYSTEM:'],
};

/** Nothing optional at all. The absent-vs-null trap lives here. */
const spare: AuditEntry = {
  at: '2026-08-24T14:25:00.000Z',
  action: 'quote_refused',
  session_id: 's2',
  envelope_id: 'env_demo_0001',
  outcome: 'refused',
  authorized_by: 'authority.floor_margin_pct',
  agent_rationale: 'no rationale supplied',
  pressure_score: 0,
  budget_remaining_inr: 40000,
  budget_limit_inr: 40000,
};

describe('SqliteLedger round trip', () => {
  it('verifies after a reopen, with every optional field set', () => {
    const first = new SqliteLedger({ path: dbPath() });
    first.append(rich);
    first.close();

    const reopened = new SqliteLedger({ path: dbPath() });
    expect(reopened.verify().ok).toBe(true);
    expect(reopened.rows).toHaveLength(1);
    reopened.close();
  });

  it('verifies after a reopen with no optional fields at all', () => {
    const first = new SqliteLedger({ path: dbPath() });
    first.append(spare);
    first.close();

    const reopened = new SqliteLedger({ path: dbPath() });
    expect(reopened.verify().ok).toBe(true);
    reopened.close();
  });

  it('brings an absent field back absent, not as null', () => {
    const ledger = new SqliteLedger({ path: dbPath() });
    ledger.append(spare);
    ledger.close();

    const reopened = new SqliteLedger({ path: dbPath() });
    const row = reopened.rows[0];
    // `'offer_id' in row` is the whole point: `row.offer_id === undefined`
    // would also be true of a key present and set to undefined, and only one of
    // those two hashes to the right thing.
    expect(row !== undefined && 'offer_id' in row).toBe(false);
    expect(row !== undefined && 'evidence' in row).toBe(false);
    reopened.close();
  });

  it('keeps clause_value a number when it was a number', () => {
    const ledger = new SqliteLedger({ path: dbPath() });
    ledger.append(rich);
    ledger.close();

    const reopened = new SqliteLedger({ path: dbPath() });
    expect(reopened.rows[0]?.clause_value).toBe(15);
    expect(typeof reopened.rows[0]?.clause_value).toBe('number');
    reopened.close();
  });

  it('keeps clause_value a string when it was a string', () => {
    const ledger = new SqliteLedger({ path: dbPath() });
    ledger.append({ ...rich, clause_value: 'pre_auth' });
    ledger.close();

    const reopened = new SqliteLedger({ path: dbPath() });
    expect(reopened.rows[0]?.clause_value).toBe('pre_auth');
    expect(typeof reopened.rows[0]?.clause_value).toBe('string');
    reopened.close();
  });

  it('produces byte-identical rows to the in-memory ledger', () => {
    // The strongest statement available: persistence adds nothing and loses
    // nothing. Same entries, same hashes, or the store is a second
    // implementation of the chain and the two will drift.
    const memory = new MemoryLedger();
    const sqlite = memoryLedger();

    for (const entry of [rich, spare, { ...rich, at: '2026-08-24T14:30:00.000Z' }]) {
      memory.append(entry);
      sqlite.append(entry);
    }

    expect(sqlite.rows).toEqual(memory.rows);
    expect(sqlite.rows.map((r) => r.hash)).toEqual(memory.rows.map((r) => r.hash));
    sqlite.close();
  });
});

describe('SqliteLedger across restarts', () => {
  it('continues one chain rather than starting a new one', () => {
    const first = new SqliteLedger({ path: dbPath() });
    first.append(rich);
    first.append(spare);
    const headBefore = first.rows.at(-1)?.hash;
    first.close();

    const second = new SqliteLedger({ path: dbPath() });
    const third = second.append({ ...spare, at: '2026-08-24T15:00:00.000Z' });

    expect(third.seq).toBe(3);
    expect(third.prev_hash).toBe(headBefore);
    expect(second.verify().ok).toBe(true);
    second.close();
  });

  it('separates sessions by query without splitting the chain', () => {
    const ledger = new SqliteLedger({ path: dbPath() });
    ledger.append(rich); // s1
    ledger.append(spare); // s2
    ledger.append({ ...rich, at: '2026-08-24T16:00:00.000Z' }); // s1

    expect(ledger.forSession('s1')).toHaveLength(2);
    expect(ledger.forSession('s2')).toHaveLength(1);
    expect(verifyChain(ledger.rows).ok).toBe(true);
    ledger.close();
  });
});

describe('append-only enforcement', () => {
  it('refuses an UPDATE at the database level', () => {
    const ledger = new SqliteLedger({ path: dbPath() });
    ledger.append(rich);
    const db = (ledger as unknown as { db: { exec: (sql: string) => void } }).db;

    expect(() => db.exec("UPDATE audit_rows SET amount_inr = 1 WHERE seq = 1")).toThrow(
      /append-only/,
    );
    ledger.close();
  });

  it('refuses a DELETE at the database level', () => {
    const ledger = new SqliteLedger({ path: dbPath() });
    ledger.append(rich);
    const db = (ledger as unknown as { db: { exec: (sql: string) => void } }).db;

    expect(() => db.exec('DELETE FROM audit_rows WHERE seq = 1')).toThrow(/append-only/);
    ledger.close();
  });
});

describe('tampering, with the guard deliberately removed', () => {
  it('catches an edited amount even though the write succeeded', () => {
    const ledger = new SqliteLedger({ path: dbPath() });
    ledger.append(rich);
    ledger.append(spare);

    const db = ledger.unsafeDropAppendOnlyGuard();
    db.exec('UPDATE audit_rows SET amount_inr = 1 WHERE seq = 1');

    const verdict = ledger.verify();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.seq).toBe(1);
      expect(verdict.problem).toBe('bad_hash');
    }
    ledger.close();
  });

  it('catches a removed row', () => {
    const ledger = new SqliteLedger({ path: dbPath() });
    ledger.append(rich);
    ledger.append(spare);
    ledger.append({ ...spare, at: '2026-08-24T17:00:00.000Z' });

    const db = ledger.unsafeDropAppendOnlyGuard();
    db.exec('DELETE FROM audit_rows WHERE seq = 2');

    const verdict = ledger.verify();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problem).toBe('out_of_order');
    ledger.close();
  });

  it('catches a rewritten rationale — the field most worth rewriting', () => {
    const ledger = new SqliteLedger({ path: dbPath() });
    ledger.append(rich);

    const db = ledger.unsafeDropAppendOnlyGuard();
    db.exec("UPDATE audit_rows SET agent_rationale = 'looked fine to me' WHERE seq = 1");

    expect(ledger.verify().ok).toBe(false);
    ledger.close();
  });
});

describe('verifyLedgerFile', () => {
  it('verifies a file it did not write, read-only', () => {
    const ledger = new SqliteLedger({ path: dbPath() });
    ledger.append(rich);
    ledger.append(spare);
    ledger.close();

    const { verification, rows } = verifyLedgerFile(dbPath());
    expect(verification.ok).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('reports the break rather than throwing', () => {
    const ledger = new SqliteLedger({ path: dbPath() });
    ledger.append(rich);
    const db = ledger.unsafeDropAppendOnlyGuard();
    db.exec('UPDATE audit_rows SET pressure_score = 0.99 WHERE seq = 1');
    ledger.close();

    const { verification } = verifyLedgerFile(dbPath());
    expect(verification.ok).toBe(false);
  });
});

/**
 * Adding a column to a table that already holds signed history.
 *
 * The hazard is specific: every row's hash is taken over its canonical JSON, so
 * if a new column came back as `null` instead of absent, every pre-existing row
 * would hash differently and a ledger nobody touched would report as tampered.
 * `ALTER TABLE ADD COLUMN` with no default is what makes this safe, and this is
 * the test that says so.
 */
describe('a ledger written before a column existed', () => {
  /** Build a database with the pre-migration schema and real chained rows. */
  function legacyLedger(entries: readonly AuditEntry[]): void {
    const memory = new MemoryLedger();
    for (const entry of entries) memory.append(entry);

    const db = new Database(dbPath());
    db.pragma('journal_mode = WAL');
    // The schema as it stood before ADDED_COLUMNS, derived from the current one
    // so this test cannot drift out of step with it.
    const legacySchema = ADDED_COLUMNS.reduce(
      (sql, column) => sql.replace(new RegExp(`\\n\\s*${column.name}\\s+\\w+,`), ''),
      SCHEMA,
    );
    for (const column of ADDED_COLUMNS) {
      if (legacySchema.includes(column.name)) {
        throw new Error(`legacy schema still contains ${column.name}`);
      }
    }
    db.exec(legacySchema);

    const columns = COLUMNS.filter((c) => c !== 'proposed_depth_pct' && c !== 'ceiling_pct');
    const insert = db.prepare(
      `INSERT INTO audit_rows (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`,
    );
    for (const row of memory.rows) {
      const { proposed_depth_pct: _p, ceiling_pct: _c, ...rest } = toColumns(row);
      insert.run(rest);
    }
    db.close();
  }

  it('does not have the column before migrating', () => {
    legacyLedger([spare]);
    const db = new Database(dbPath(), { readonly: true });
    const names = (db.prepare('PRAGMA table_info(audit_rows)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    db.close();
    expect(names).not.toContain('proposed_depth_pct');
    expect(names).not.toContain('ceiling_pct');
  });

  it('still verifies after the column is added', () => {
    legacyLedger([spare, { ...spare, at: '2026-08-24T14:26:00.000Z' }]);

    const ledger = new SqliteLedger({ path: dbPath() });
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.verify().ok).toBe(true);
    ledger.close();
  });

  it('reads the migrated rows back with the field absent, not null', () => {
    legacyLedger([spare]);
    const ledger = new SqliteLedger({ path: dbPath() });
    const row = ledger.rows[0];
    expect(row !== undefined && 'proposed_depth_pct' in row).toBe(false);
    expect(row !== undefined && 'ceiling_pct' in row).toBe(false);
    ledger.close();
  });

  it('continues the chain from a migrated ledger', () => {
    legacyLedger([spare]);

    const ledger = new SqliteLedger({ path: dbPath() });
    const appended = ledger.append({ ...rich, at: '2026-08-24T15:00:00.000Z' });
    expect(appended.seq).toBe(2);
    expect(appended.proposed_depth_pct).toBe(22);
    expect(appended.ceiling_pct).toBe(15);
    expect(ledger.verify().ok).toBe(true);
    ledger.close();

    // And it survives one more reopen, now that both shapes are in one file.
    expect(verifyLedgerFile(dbPath()).verification.ok).toBe(true);
  });
});
