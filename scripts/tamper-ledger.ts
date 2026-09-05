/**
 * Try to rewrite the audit ledger, and watch it fail twice.
 *
 *   pnpm tamper:check [path/to/ledger.db]
 *
 * "The audit trail is tamper-evident" is the kind of claim that should never be
 * taken on trust, least of all from the people who wrote it. This runs the
 * attack: open the database with full write access, edit the field an
 * embarrassed merchant would most want to edit, and see what happens.
 *
 * Two defences, in order:
 *
 *   1. The append-only triggers refuse the UPDATE outright. This is the weaker
 *      of the two — anyone with the file can drop a trigger — and its value is
 *      that nothing tampers with this ledger by accident or in passing.
 *   2. The hash chain catches the edit once the trigger is gone. This is the
 *      one that matters, and it holds against an attacker with complete
 *      database access, because it does not depend on the database at all.
 *
 * WORKS ON A COPY, ALWAYS. A script that corrupts the real ledger to prove a
 * point about ledger integrity would be a poor joke. The original is never
 * opened for writing.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ledgerPath } from '@counterparty/config';
import { verifyLedgerFile } from '@counterparty/store';

const OK = 'PASS';
const NO = 'FAIL';

function main(): void {
  const source = process.argv[2] ?? ledgerPath();

  if (!existsSync(source)) {
    console.error(
      `\nNo ledger at ${source}.\n` +
        'Run `pnpm dev` and take a turn or two in the console first — this checks a\n' +
        'ledger that actually has rows in it.\n',
    );
    process.exit(1);
  }

  const copy = join(tmpdir(), `counterparty-tamper-${process.pid}.db`);

  /**
   * `VACUUM INTO`, not a file copy.
   *
   * The ledger runs in WAL mode, so recent rows live in `console.db-wal` and
   * have not necessarily reached the main file yet. Copying `console.db` alone
   * yields a database that is missing rows — or, if nothing has checkpointed
   * yet, missing the table entirely, which is exactly what happened the first
   * time this script ran. `VACUUM INTO` asks SQLite for a consistent snapshot
   * and lets it worry about where the bytes currently are.
   */
  const reader = new Database(source, { readonly: true, fileMustExist: true });
  try {
    reader.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  } finally {
    reader.close();
  }

  try {
    const before = verifyLedgerFile(copy);
    console.log(`\nLedger copy — ${before.rows.length} row(s)`);
    console.log(`  ${before.verification.ok ? OK : NO}  the chain verifies before anything is touched\n`);
    if (!before.verification.ok) {
      console.log('  Nothing further to prove: this ledger was already broken.\n');
      process.exit(1);
    }

    const target = before.rows[0];
    if (target === undefined) {
      console.log('  Empty ledger — nothing to tamper with.\n');
      process.exit(1);
    }

    const db = new Database(copy);
    const forgery = 'looked fine to me';

    console.log('1. An ordinary UPDATE, as someone holding the file:\n');
    try {
      db.exec(`UPDATE audit_rows SET agent_rationale = '${forgery}' WHERE seq = ${target.seq}`);
      console.log(`   ${NO}  the UPDATE succeeded — the append-only guard is missing\n`);
    } catch (error) {
      console.log(`   ${OK}  refused by the database: ${(error as Error).message}\n`);
    }

    console.log('2. Now drop the guard and edit anyway:\n');
    db.exec('DROP TRIGGER IF EXISTS audit_rows_no_update');
    db.exec(`UPDATE audit_rows SET agent_rationale = '${forgery}' WHERE seq = ${target.seq}`);
    db.close();
    console.log(`   row ${target.seq} rationale is now "${forgery}"`);
    console.log(`   it used to read     "${target.agent_rationale.slice(0, 60)}"\n`);

    const after = verifyLedgerFile(copy);
    if (after.verification.ok) {
      console.log(`   ${NO}  the chain still verifies. The edit went undetected.\n`);
      process.exit(1);
    }

    console.log(`   ${OK}  ${after.verification.problem} at row ${after.verification.seq}`);
    console.log(`         ${after.verification.detail}\n`);
    console.log('The edit succeeded and changed nothing about whether it is believed.');
    console.log('That is the whole property: the ledger does not have to be unwritable,');
    console.log('it has to be unable to lie about having been written to.\n');
  } finally {
    rmSync(copy, { force: true });
    rmSync(`${copy}-wal`, { force: true });
    rmSync(`${copy}-shm`, { force: true });
  }
}

main();
