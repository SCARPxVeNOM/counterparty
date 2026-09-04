/**
 * The revenue comparison, checked against arithmetic anyone can redo by hand.
 *
 * The numbers here are deliberately round. A test that agrees with the
 * implementation to four decimal places proves the implementation is
 * self-consistent; these check it against sums a reader can verify in their head,
 * which is the only kind of check worth having on a figure that goes in a pitch.
 *
 * The case that matters most is the second block. The first version of this
 * comparison reported a difference of zero across the whole demo, because after
 * the envelope collapses the agent proposes 0% and that looks identical to a
 * buyer who never asked for anything. Several tests here exist specifically to
 * fail if that mistake comes back.
 */

import { describe, expect, it } from 'vitest';
import { append, openLedger, type AuditEntry, type AuditLedger } from '../../src/audit/ledger';
import { counterfactual, formatCounterfactual } from '../../src/audit/counterfactual';

const BASE = {
  at: '2026-09-04T10:00:00Z',
  session_id: 's1',
  envelope_id: 'env_test',
  authorized_by: 'authority.max_discount_depth_pct',
  agent_rationale: 'a rationale',
  pressure_score: 0,
  budget_remaining_inr: 40000,
  budget_limit_inr: 40000,
} as const;

/**
 * A signed deal on ₹10,000 of list.
 *
 * `ceiling` is what the agent was permitted to propose up to; `granted` is what
 * the gate signed. `proposed_depth_pct` defaults to `granted` — the ordinary
 * case, where the gate signs what the agent asked for. Overriding it apart from
 * `granted` is how a refuse-and-counter turn is expressed.
 */
function deal(
  buyer: string,
  ceiling: number,
  granted: number,
  overrides: Partial<AuditEntry> = {},
): AuditEntry {
  return {
    ...BASE,
    action: granted > 0 ? 'discount_conceded' : 'quote_issued',
    outcome: 'signed',
    buyer_id: buyer,
    list_inr: 10000,
    amount_inr: 10000 * (1 - granted / 100),
    depth_pct: granted,
    ceiling_pct: ceiling,
    proposed_depth_pct: granted,
    ...overrides,
  } as AuditEntry;
}

function ledgerOf(entries: readonly AuditEntry[]): AuditLedger {
  return entries.reduce<AuditLedger>((ledger, entry) => append(ledger, entry), openLedger());
}

describe('when nothing was binding', () => {
  it('reports no difference', () => {
    // Full 15% ceiling, agent proposed 10, gate signed 10. A flat cap does the same.
    const result = counterfactual(ledgerOf([deal('honest', 15, 10)]).rows);
    expect(result.deltaInr).toBe(0);
    expect(result.divergent).toBe(0);
    expect(result.envelopeRevenueInr).toBe(9000);
    expect(result.staticRevenueInr).toBe(9000);
  });

  it('reports no difference when the agent went to the full ceiling', () => {
    const result = counterfactual(ledgerOf([deal('pushy', 15, 15)]).rows);
    expect(result.deltaInr).toBe(0);
    expect(result.staticRevenueInr).toBe(8500);
  });

  it('does not mark an unbound deal as bound', () => {
    expect(counterfactual(ledgerOf([deal('honest', 15, 10)]).rows).lines[0]?.bound).toBe(false);
  });
});

describe('when the envelope tightened before the agent spoke', () => {
  /**
   * The collapse case, and the reason this file compares ceilings rather than
   * asks. Everything the agent said was already constrained: it proposed 0%
   * because 0% was all it had. A flat cap has no pressure state, so it would
   * have had the full 15% available to a buyer pushing hard for it.
   */
  it('counts the money a flat cap would have given the injector', () => {
    const result = counterfactual(
      ledgerOf([
        deal('injector', 0, 0, {
          authorized_by: 'pressure_policy.collapse_threshold',
          pressure_score: 1,
        }),
      ]).rows,
    );
    expect(result.envelopeRevenueInr).toBe(10000);
    expect(result.staticRevenueInr).toBe(8500);
    expect(result.deltaInr).toBe(1500);
    expect(result.divergent).toBe(1);
    expect(result.lines[0]?.bound).toBe(true);
  });

  it('does not mistake a collapsed agent for an undemanding buyer', () => {
    // Identical granted depth, identical proposal. Only the ceiling differs, and
    // it has to be enough to tell the two apart.
    const collapsed = counterfactual(ledgerOf([deal('injector', 0, 0)]).rows);
    const uninterested = counterfactual(ledgerOf([deal('browser', 15, 0)]).rows);

    expect(collapsed.deltaInr).toBe(1500);
    expect(uninterested.deltaInr).toBe(0);
  });

  it('counts a partial tightening proportionally', () => {
    // GUARDED rather than COLLAPSED: the ceiling dropped to 7.5%, not to zero.
    const result = counterfactual(ledgerOf([deal('probing', 7.5, 7.5)]).rows);
    expect(result.staticRevenueInr).toBe(8500);
    expect(result.envelopeRevenueInr).toBe(9250);
    expect(result.deltaInr).toBe(750);
  });

  it('puts the whole difference on the pressured session and none elsewhere', () => {
    const result = counterfactual(
      ledgerOf([
        deal('honest', 15, 12, { session_id: 'a' }),
        deal('injector', 0, 0, { session_id: 'b', pressure_score: 1 }),
        deal('bulk', 15, 8, { session_id: 'c' }),
      ]).rows,
    );
    expect(result.lines).toHaveLength(3);
    expect(result.divergent).toBe(1);
    expect(result.deltaInr).toBe(1500);

    const byBuyer = new Map(result.lines.map((l) => [l.buyerId, l.deltaInr]));
    expect(byBuyer.get('honest')).toBe(0);
    expect(byBuyer.get('bulk')).toBe(0);
    expect(byBuyer.get('injector')).toBe(1500);
  });

  it('states the uplift as a percentage of the baseline', () => {
    // 1500 / 8500
    expect(counterfactual(ledgerOf([deal('injector', 0, 0)]).rows).upliftPct).toBe(17.65);
  });
});

describe('when the gate cut the agent down after it proposed', () => {
  /**
   * The budget case. The ceiling was the full 15% — pressure was not the issue —
   * so the agent proposed 12% freely and a flat cap would have signed that. The
   * depleted budget clause is what took it to 4%, and a flat cap has no such
   * clause.
   */
  it('credits the cap with what the agent actually proposed, not the cap itself', () => {
    const result = counterfactual(
      ledgerOf([
        deal('bulk', 15, 4, {
          proposed_depth_pct: 12,
          authorized_by: 'authority.discount_budget_inr_per_day',
        }),
      ]).rows,
    );
    expect(result.lines[0]?.staticPct).toBe(12);
    expect(result.staticRevenueInr).toBe(8800);
    expect(result.envelopeRevenueInr).toBe(9600);
    expect(result.deltaInr).toBe(800);
    expect(result.lines[0]?.bound).toBe(true);
  });
});

describe('what does not get counted', () => {
  it('ignores refusals — a refused quote is not a sale', () => {
    const result = counterfactual(
      ledgerOf([
        { ...BASE, action: 'quote_refused', outcome: 'refused', ceiling_pct: 15 } as AuditEntry,
        deal('buyer', 15, 10),
      ]).rows,
    );
    expect(result.lines).toHaveLength(1);
  });

  it('ignores pressure incidents', () => {
    const result = counterfactual(
      ledgerOf([
        { ...BASE, action: 'pressure_incident', outcome: 'logged' } as AuditEntry,
        deal('buyer', 15, 10),
      ]).rows,
    );
    expect(result.lines).toHaveLength(1);
  });

  /**
   * Campaign offers are the merchant choosing to spend, not a buyer extracting
   * anything, so a flat cap would have run the identical campaign. Counting them
   * adds a matched pair to both columns and dilutes the only figure that means
   * something.
   */
  it('excludes campaign offers without calling them uncomparable', () => {
    const result = counterfactual(
      ledgerOf([
        deal('member_1', 15, 12, { action: 'campaign_offer_issued' }),
        deal('buyer', 15, 10, { session_id: 'neg' }),
      ]).rows,
    );
    expect(result.lines).toHaveLength(1);
    expect(result.uncomparable).toBe(0);
  });

  /**
   * The double-counting trap. A negotiation that quotes, gets pushed, and
   * re-quotes produced one sale, and counting both signed rows would book the
   * same kettle twice.
   */
  it('counts only the last signed offer per buyer per session', () => {
    const result = counterfactual(
      ledgerOf([deal('buyer', 15, 5), deal('buyer', 15, 12)]).rows,
    );
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.envelopePct).toBe(12);
    expect(result.listTotalInr).toBe(10000);
  });

  it('keeps the same buyer id in two different sessions apart', () => {
    const result = counterfactual(
      ledgerOf([
        deal('buyer', 15, 5, { session_id: 'monday' }),
        deal('buyer', 15, 5, { session_id: 'tuesday' }),
      ]).rows,
    );
    expect(result.lines).toHaveLength(2);
    expect(result.listTotalInr).toBe(20000);
  });

  it('reports rows it could not compare rather than dropping them silently', () => {
    const result = counterfactual(
      ledgerOf([
        // Written before ceiling_pct existed.
        deal('old', 15, 10, { ceiling_pct: undefined }),
        deal('new', 15, 10, { session_id: 'other' }),
      ]).rows,
    );
    expect(result.lines).toHaveLength(1);
    expect(result.uncomparable).toBe(1);
  });
});

describe('the cap it is compared against', () => {
  it('defaults to 15, the envelope’s own ceiling', () => {
    expect(counterfactual(ledgerOf([deal('b', 0, 0)]).rows).capPct).toBe(15);
  });

  it('shrinks the measured advantage against a stingier cap', () => {
    const rows = ledgerOf([deal('injector', 0, 0)]).rows;
    expect(counterfactual(rows, { capPct: 5 }).deltaInr).toBe(500);
    expect(counterfactual(rows, { capPct: 15 }).deltaInr).toBe(1500);
  });

  it('finds nothing to credit when the cap is at or below the tightened ceiling', () => {
    // A 5% flat cap against a 7.5% guarded ceiling: the envelope was the looser
    // of the two, so there is no advantage to claim and the code must not invent one.
    const result = counterfactual(ledgerOf([deal('probing', 7.5, 7.5)]).rows, { capPct: 5 });
    expect(result.lines[0]?.staticPct).toBe(5);
    expect(result.deltaInr).toBe(-250);
  });
});

describe('the report', () => {
  it('shows the total and the uplift', () => {
    const text = formatCounterfactual(
      counterfactual(
        ledgerOf([deal('honest', 15, 10), deal('injector', 0, 0, { session_id: 'b' })]).rows,
      ),
    );
    expect(text).toContain('flat 15% cap');
    expect(text).toContain('2 deal(s)');
    expect(text).toContain('₹1,500');
  });

  it('says so plainly when there is nothing to compare', () => {
    expect(formatCounterfactual(counterfactual([]))).toContain('No comparable signed offers');
  });
});
