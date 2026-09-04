/**
 * The audit ledger, on disk.
 *
 * WHY THIS EXISTS. The hash chain was already tamper-evident and already
 * verified from scratch on every check. What it was not, was durable: the whole
 * thing lived in an array, so restarting the console erased the record whose
 * entire purpose is to outlive the thing that wrote it. "Prove the audit trail
 * was not edited" is a weaker claim than it sounds when the trail is gone the
 * moment anybody stops looking.
 *
 * WHAT IT DOES NOT CHANGE. Chaining, hashing and verification all still happen
 * in `packages/core`, in the same pure functions, over the same canonical bytes.
 * This class calls `append` and writes down what it returned. It computes
 * nothing itself — a persistence layer that re-derived hashes would be a second
 * implementation of the property the first one exists to guarantee, and the two
 * would eventually disagree.
 *
 * ONE CHAIN PER FILE. Rows from every session land in one continuous chain, in
 * write order, which is what makes the chain worth anything across restarts: a
 * per-session chain would let an entire session be dropped without leaving a
 * gap. `session_id` is a column, so a single session is a WHERE clause rather
 * than a separate ledger.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import {
  append,
  openLedger,
  verifyChain,
  type AuditEntry,
  type AuditLedger,
  type AuditRow,
  type ChainVerification,
  type LedgerWriter,
} from '@counterparty/core';
import { fromColumns, toColumns, type StoredRow } from './rows';
import {
  ADDED_COLUMNS,
  APPEND_ONLY_TRIGGERS,
  DROP_APPEND_ONLY_TRIGGERS,
  INSERT_SQL,
  SCHEMA,
} from './schema';

export interface SqliteLedgerOptions {
  /** `:memory:` for tests that want the real SQL without a file. */
  readonly path: string;
  /**
   * Leave the append-only triggers off.
   *
   * Only the tamper test should ever pass this. It is spelled out rather than
   * left to a `db.exec` somewhere so that switching the guard off is a visible,
   * greppable act.
   */
  readonly withoutAppendOnlyGuard?: boolean;
}

export class SqliteLedger implements LedgerWriter {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement;
  /** Mirrors the table, so `rows` costs nothing and `append` has its head. */
  private state: AuditLedger;

  constructor(options: SqliteLedgerOptions) {
    if (options.path !== ':memory:') {
      const directory = dirname(options.path);
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    }

    this.db = new Database(options.path);
    // Survives an unclean shutdown mid-write, which for an audit trail is the
    // difference between a missing row and a corrupt file.
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
    if (options.withoutAppendOnlyGuard !== true) this.db.exec(APPEND_ONLY_TRIGGERS);

    this.insert = this.db.prepare(INSERT_SQL);
    this.state = this.load();
  }

  /**
   * Add columns that did not exist when this file was written.
   *
   * Runs before the triggers go on, because `ALTER TABLE` on a table carrying an
   * append-only UPDATE trigger is fine but the ordering is easier to reason
   * about this way. Adding a column does not touch a single existing row, which
   * is the only reason this is safe to do to an audit ledger at all.
   */
  private migrate(): void {
    const present = new Set(
      (this.db.prepare('PRAGMA table_info(audit_rows)').all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    for (const column of ADDED_COLUMNS) {
      if (!present.has(column.name)) this.db.exec(column.ddl);
    }
  }

  private load(): AuditLedger {
    const stored = this.db
      .prepare('SELECT * FROM audit_rows ORDER BY seq ASC')
      .all() as StoredRow[];
    return { rows: stored.map(fromColumns) };
  }

  get rows(): readonly AuditRow[] {
    return this.state.rows;
  }

  append(entry: AuditEntry): AuditRow {
    const next = append(this.state, entry);
    const written = next.rows.at(-1);
    if (written === undefined) throw new Error('append produced no row');

    this.insert.run(toColumns(written));
    this.state = next;
    return written;
  }

  /**
   * Re-read from the file and verify.
   *
   * Deliberately does not verify `this.state`. Checking the in-memory mirror
   * would prove only that this process is self-consistent, which it inevitably
   * is; the question worth answering is whether what is *on disk* still hashes
   * to what it claims.
   */
  verify(): ChainVerification {
    return verifyChain(this.load().rows);
  }

  /** Rows for one session, in order. The chain still spans the whole file. */
  forSession(sessionId: string): readonly AuditRow[] {
    const stored = this.db
      .prepare('SELECT * FROM audit_rows WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as StoredRow[];
    return stored.map(fromColumns);
  }

  get size(): number {
    return this.state.rows.length;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Raw handle, for a caller that has to defeat the guard on purpose.
   *
   * The only legitimate use is demonstrating that the chain catches an edit the
   * trigger no longer refuses. Named so that it cannot appear in a diff without
   * a reviewer noticing.
   */
  unsafeDropAppendOnlyGuard(): Database.Database {
    this.db.exec(DROP_APPEND_ONLY_TRIGGERS);
    return this.db;
  }
}

/** Open a ledger file read-only and verify it. Used by the CLI. */
export function verifyLedgerFile(path: string): {
  readonly verification: ChainVerification;
  readonly rows: readonly AuditRow[];
} {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const stored = db.prepare('SELECT * FROM audit_rows ORDER BY seq ASC').all() as StoredRow[];
    const rows = stored.map(fromColumns);
    return { verification: verifyChain(rows), rows };
  } finally {
    db.close();
  }
}

/** An empty in-memory ledger, for tests that want the SQL without a file. */
export function memoryLedger(): SqliteLedger {
  return new SqliteLedger({ path: ':memory:' });
}

export { openLedger };
