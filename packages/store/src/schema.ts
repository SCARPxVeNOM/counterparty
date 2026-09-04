/**
 * The audit table.
 *
 * TYPED COLUMNS, NOT A JSON BLOB. Storing each row as one serialized string
 * would make the round-trip trivially faithful, and would also reduce SQLite to
 * a filename. Real columns mean the ledger can be queried — every refusal citing
 * a given clause, the budget curve across a day — and, more to the point, they
 * make the tamper demonstration honest: someone with database access edits
 * `amount_inr` with ordinary SQL, and the chain catches it. Editing a field
 * inside an opaque blob is not the threat anyone is worried about.
 *
 * The cost is that the round trip has to be exactly faithful or the chain breaks
 * on reload, since every hash is taken over canonical JSON of the row. Two
 * places where that is easy to get wrong, both handled in `rows.ts`:
 *
 *   - an absent optional field must come back ABSENT, never as `null`
 *   - `clause_value` is `string | number`, and SQLite would happily flatten
 *     `15` into `'15'`
 *
 * There is a test that writes a row with every optional field set, another with
 * none of them, and re-verifies the chain after reopening the file.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_rows (
  seq                  INTEGER PRIMARY KEY,
  at                   TEXT    NOT NULL,
  action               TEXT    NOT NULL,
  session_id           TEXT    NOT NULL,
  envelope_id          TEXT    NOT NULL,
  outcome              TEXT    NOT NULL,
  authorized_by        TEXT    NOT NULL,
  clause_value         TEXT,
  agent_rationale      TEXT    NOT NULL,
  pressure_score       REAL    NOT NULL,
  budget_remaining_inr REAL    NOT NULL,
  budget_limit_inr     REAL    NOT NULL,
  offer_id             TEXT,
  buyer_id             TEXT,
  amount_inr           REAL,
  list_inr             REAL,
  depth_pct            REAL,
  proposed_depth_pct   REAL,
  ceiling_pct          REAL,
  settlement_path      TEXT,
  post_auth_reason     TEXT,
  rails                TEXT,
  signature            TEXT,
  evidence             TEXT,
  prev_hash            TEXT    NOT NULL,
  hash                 TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_rows_session ON audit_rows (session_id);
CREATE INDEX IF NOT EXISTS audit_rows_action  ON audit_rows (action);
`;

/**
 * Append-only, enforced by the database rather than by convention.
 *
 * The hash chain already makes an edit *detectable*. These make it *awkward* —
 * an ordinary UPDATE or DELETE is refused outright, so tampering requires
 * deliberately dismantling the guard first. That is the useful property: not
 * that nobody can rewrite history, which no local file can promise, but that
 * nobody can do it by accident or quietly.
 *
 * Kept separate from SCHEMA so a test can drop them and prove the chain still
 * catches what the trigger no longer stops. A defence that has never been
 * tested with the other defence removed is a defence nobody has measured.
 */
export const APPEND_ONLY_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS audit_rows_no_update
BEFORE UPDATE ON audit_rows
BEGIN SELECT RAISE(ABORT, 'audit_rows is append-only: rows cannot be updated'); END;

CREATE TRIGGER IF NOT EXISTS audit_rows_no_delete
BEFORE DELETE ON audit_rows
BEGIN SELECT RAISE(ABORT, 'audit_rows is append-only: rows cannot be deleted'); END;
`;

export const DROP_APPEND_ONLY_TRIGGERS = `
DROP TRIGGER IF EXISTS audit_rows_no_update;
DROP TRIGGER IF EXISTS audit_rows_no_delete;
`;

/** Column order for INSERT. Shared so the statement and the binder cannot drift. */
export const COLUMNS = [
  'seq',
  'at',
  'action',
  'session_id',
  'envelope_id',
  'outcome',
  'authorized_by',
  'clause_value',
  'agent_rationale',
  'pressure_score',
  'budget_remaining_inr',
  'budget_limit_inr',
  'offer_id',
  'buyer_id',
  'amount_inr',
  'list_inr',
  'depth_pct',
  'proposed_depth_pct',
  'ceiling_pct',
  'settlement_path',
  'post_auth_reason',
  'rails',
  'signature',
  'evidence',
  'prev_hash',
  'hash',
] as const;

export const INSERT_SQL = `INSERT INTO audit_rows (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(
  (column) => `@${column}`,
).join(', ')})`;

/**
 * Columns added after ledgers existed in the wild.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already there, so
 * a new column has to be added explicitly or every existing ledger fails on the
 * next insert. `ALTER TABLE ADD COLUMN` gives existing rows NULL, which
 * `fromColumns` reads back as *absent* — so their canonical JSON is byte-identical
 * to what it was, their hashes are unchanged, and the chain still verifies across
 * the migration. That property is why every added column has to be nullable and
 * optional: a column with a default would rewrite history to add a field that was
 * never signed.
 *
 * There is a test that verifies a chain written before the column existed.
 */
export const ADDED_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: 'proposed_depth_pct', ddl: 'ALTER TABLE audit_rows ADD COLUMN proposed_depth_pct REAL' },
  { name: 'ceiling_pct', ddl: 'ALTER TABLE audit_rows ADD COLUMN ceiling_pct REAL' },
];
