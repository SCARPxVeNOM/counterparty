import { describe, expect, it } from 'vitest';
import {
  available,
  commit,
  dayKeyOf,
  drawnByBuyer,
  ensureDay,
  expireStale,
  openBudget,
  poolPosition,
  release,
  reserve,
  reserved,
  spent,
  type BudgetState,
} from '../../src/budget/ledger';
import { rupeesToPaise } from '../../src/money';

const LIMIT = rupeesToPaise(40000);
const NOW = new Date('2026-08-25T09:00:00+05:30');
const MINUTE = 60_000;

function fresh(): BudgetState {
  return openBudget(LIMIT, dayKeyOf(NOW));
}

function reserveOrThrow(state: BudgetState, id: string, rupees: number, buyerId: string, now = NOW): BudgetState {
  const result = reserve(state, { id, amount: rupeesToPaise(rupees), buyerId, purpose: 'negotiation', ttlMs: 15 * MINUTE }, now);
  if (!result.ok) throw new Error(`expected reserve to succeed: ${result.detail}`);
  return result.state;
}

describe('a fresh pool', () => {
  it('has the whole daily limit available', () => {
    expect(available(fresh(), NOW)).toBe(LIMIT);
    expect(spent(fresh())).toBe(0);
  });
});

describe('reserve', () => {
  it('holds budget without spending it', () => {
    const state = reserveOrThrow(fresh(), 'quote_1', 5000, 'buyer_a');
    expect(spent(state)).toBe(0);
    expect(reserved(state, NOW)).toBe(rupeesToPaise(5000));
    expect(available(state, NOW)).toBe(rupeesToPaise(35000));
  });

  /**
   * The reason reservations exist. Ten live quotes at ₹5k of discount each
   * against a ₹40k pool is ₹50k of exposure if they all come back.
   */
  it('cannot oversubscribe the pool with outstanding quotes', () => {
    let state = fresh();
    for (let i = 0; i < 8; i += 1) {
      state = reserveOrThrow(state, `quote_${i}`, 5000, `buyer_${i}`);
    }
    expect(available(state, NOW)).toBe(0);

    const ninth = reserve(
      state,
      { id: 'quote_8', amount: rupeesToPaise(5000), buyerId: 'buyer_8', purpose: 'negotiation', ttlMs: MINUTE },
      NOW,
    );
    expect(ninth.ok).toBe(false);
    if (!ninth.ok) expect(ninth.reason).toBe('daily_budget_exhausted');
  });

  it('refuses a duplicate reservation id', () => {
    const state = reserveOrThrow(fresh(), 'quote_1', 5000, 'buyer_a');
    const again = reserve(
      state,
      { id: 'quote_1', amount: rupeesToPaise(100), buyerId: 'buyer_a', purpose: 'negotiation', ttlMs: MINUTE },
      NOW,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('duplicate_reservation');
  });

  it('reports what remains when it refuses', () => {
    const state = reserveOrThrow(fresh(), 'quote_1', 39000, 'buyer_a');
    const tooBig = reserve(
      state,
      { id: 'quote_2', amount: rupeesToPaise(5000), buyerId: 'buyer_b', purpose: 'negotiation', ttlMs: MINUTE },
      NOW,
    );
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.available).toBe(rupeesToPaise(1000));
  });
});

describe('expiry', () => {
  it('hands budget back when a quote lapses', () => {
    const state = reserveOrThrow(fresh(), 'quote_1', 5000, 'buyer_a');
    expect(available(state, NOW)).toBe(rupeesToPaise(35000));

    const later = new Date(NOW.getTime() + 20 * MINUTE);
    expect(available(state, later)).toBe(LIMIT);
    expect(expireStale(state, later).reservations).toHaveLength(0);
  });

  it('refuses to commit a lapsed reservation', () => {
    const state = reserveOrThrow(fresh(), 'quote_1', 5000, 'buyer_a');
    const tooLate = commit(state, 'quote_1', new Date(NOW.getTime() + 20 * MINUTE));
    expect(tooLate.ok).toBe(false);
    if (!tooLate.ok) expect(tooLate.reason).toBe('reservation_expired');
  });

  it('lets the freed budget be reserved by someone else', () => {
    const held = reserveOrThrow(fresh(), 'quote_1', 40000, 'buyer_a');
    const later = new Date(NOW.getTime() + 20 * MINUTE);
    const next = reserve(
      held,
      { id: 'quote_2', amount: rupeesToPaise(40000), buyerId: 'buyer_b', purpose: 'campaign', ttlMs: MINUTE },
      later,
    );
    expect(next.ok).toBe(true);
  });
});

describe('commit and release', () => {
  it('turns a reservation into a commitment', () => {
    const held = reserveOrThrow(fresh(), 'quote_1', 5000, 'buyer_a');
    const settled = commit(held, 'quote_1', NOW);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;

    expect(spent(settled.state)).toBe(rupeesToPaise(5000));
    expect(reserved(settled.state, NOW)).toBe(0);
    expect(available(settled.state, NOW)).toBe(rupeesToPaise(35000));
  });

  it('gives budget back on release', () => {
    const held = reserveOrThrow(fresh(), 'quote_1', 5000, 'buyer_a');
    const freed = release(held, 'quote_1');
    expect(freed.ok).toBe(true);
    if (freed.ok) expect(available(freed.state, NOW)).toBe(LIMIT);
  });

  it('refuses to commit or release something it never held', () => {
    expect(commit(fresh(), 'nope', NOW).ok).toBe(false);
    expect(release(fresh(), 'nope').ok).toBe(false);
  });

  it('does not let a reservation be committed twice', () => {
    const held = reserveOrThrow(fresh(), 'quote_1', 5000, 'buyer_a');
    const once = commit(held, 'quote_1', NOW);
    if (!once.ok) throw new Error('setup failed');
    expect(commit(once.state, 'quote_1', NOW).ok).toBe(false);
  });
});

describe('per-buyer draw', () => {
  it('counts commitments and live reservations together', () => {
    let state = reserveOrThrow(fresh(), 'quote_1', 1200, 'buyer_a');
    const settled = commit(state, 'quote_1', NOW);
    if (!settled.ok) throw new Error('setup failed');
    state = reserveOrThrow(settled.state, 'quote_2', 800, 'buyer_a');

    expect(drawnByBuyer(state, 'buyer_a', NOW)).toBe(rupeesToPaise(2000));
    expect(drawnByBuyer(state, 'buyer_b', NOW)).toBe(0);
  });

  it('stops counting a reservation once it lapses', () => {
    const state = reserveOrThrow(fresh(), 'quote_1', 800, 'buyer_a');
    expect(drawnByBuyer(state, 'buyer_a', new Date(NOW.getTime() + 20 * MINUTE))).toBe(0);
  });
});

describe('the shared pool', () => {
  /**
   * The coupling that proves the envelope is one authority object. A campaign
   * and a negotiation draw from the same pool, so spending in one genuinely
   * constrains the other.
   */
  it('lets a campaign consume budget a negotiation then cannot have', () => {
    const campaign = reserve(
      fresh(),
      { id: 'camp_1', amount: rupeesToPaise(28000), buyerId: 'segment_lapsed', purpose: 'campaign', ttlMs: 60 * MINUTE },
      NOW,
    );
    if (!campaign.ok) throw new Error('setup failed');
    const burned = commit(campaign.state, 'camp_1', NOW);
    if (!burned.ok) throw new Error('setup failed');

    expect(available(burned.state, NOW)).toBe(rupeesToPaise(12000));

    const negotiation = reserve(
      burned.state,
      { id: 'quote_9', amount: rupeesToPaise(15000), buyerId: 'buyer_a', purpose: 'negotiation', ttlMs: MINUTE },
      NOW,
    );
    expect(negotiation.ok).toBe(false);
    if (!negotiation.ok) expect(negotiation.reason).toBe('daily_budget_exhausted');
  });

  it('reports its position for the audit row', () => {
    const held = reserveOrThrow(fresh(), 'quote_1', 28800, 'buyer_a');
    const position = poolPosition(held, NOW);
    expect(position.remaining).toBe(rupeesToPaise(11200));
    expect(position.limit).toBe(rupeesToPaise(40000));
  });
});

describe('the trading day', () => {
  it('keys days in the merchant timezone, not UTC', () => {
    // 23:00 UTC on the 24th is already 04:30 on the 25th in Asia/Kolkata.
    expect(dayKeyOf(new Date('2026-08-24T23:00:00Z'))).toBe('2026-08-25');
    expect(dayKeyOf(new Date('2026-08-24T18:00:00Z'))).toBe('2026-08-24');
  });

  it('rolls the ledger over on a new day', () => {
    let state = reserveOrThrow(fresh(), 'quote_1', 30000, 'buyer_a');
    const settled = commit(state, 'quote_1', NOW);
    if (!settled.ok) throw new Error('setup failed');
    state = settled.state;
    expect(available(state, NOW)).toBe(rupeesToPaise(10000));

    const tomorrow = new Date('2026-08-26T09:00:00+05:30');
    const rolled = ensureDay(state, tomorrow);
    expect(available(rolled, tomorrow)).toBe(LIMIT);
    expect(rolled.day).toBe('2026-08-26');
  });

  it('leaves the ledger alone within the same day', () => {
    const state = reserveOrThrow(fresh(), 'quote_1', 5000, 'buyer_a');
    const laterSameDay = new Date('2026-08-25T22:00:00+05:30');
    expect(ensureDay(state, laterSameDay)).toBe(state);
  });
});
