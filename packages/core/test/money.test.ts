import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  addPaise,
  applyDepth,
  depthPctOf,
  discountFor,
  formatInr,
  formatPct,
  marginPctAt,
  paise,
  paiseToRupees,
  rupeesToPaise,
  subPaise,
} from '../src/money';

describe('paise construction', () => {
  it('rejects fractional paise', () => {
    expect(() => paise(1.5)).toThrow(MoneyError);
  });

  it('rejects negative amounts', () => {
    expect(() => paise(-1)).toThrow(MoneyError);
  });

  it('converts rupees exactly', () => {
    expect(rupeesToPaise(4990)).toBe(499000);
    expect(paiseToRupees(paise(499000))).toBe(4990);
  });

  it('converts fractional rupees without binary drift', () => {
    // 4990.05 * 100 is 499004.99999... in binary floating point.
    expect(rupeesToPaise(4990.05)).toBe(499005);
    expect(rupeesToPaise(0.07)).toBe(7);
    expect(rupeesToPaise(1.1)).toBe(110);
  });
});

describe('paise arithmetic', () => {
  it('adds and subtracts', () => {
    expect(addPaise(paise(100), paise(250))).toBe(350);
    expect(subPaise(paise(350), paise(100))).toBe(250);
  });

  it('refuses a subtraction that would go negative', () => {
    expect(() => subPaise(paise(100), paise(250))).toThrow(MoneyError);
  });
});

describe('discount arithmetic', () => {
  it('computes the design note example exactly', () => {
    // list ₹4,990 at 15.0% depth settles at ₹4,241.50.
    const list = rupeesToPaise(4990);
    expect(discountFor(list, 15)).toBe(74850);
    expect(applyDepth(list, 15)).toBe(424150);
  });

  /**
   * Rounding direction is policy, not arithmetic taste. Rounding the discount
   * down means the realised depth is always at or under the authorized ceiling,
   * so an audit row can never claim a clause permitted a depth it did not.
   */
  it('rounds the discount down so realised depth never exceeds the authorized ceiling', () => {
    const list = paise(333); // 15% of 333 is 49.95 paise
    expect(discountFor(list, 15)).toBe(49);
    expect(depthPctOf(list, applyDepth(list, 15))).toBeLessThanOrEqual(15);
  });

  it('never exceeds the ceiling across a sweep of awkward prices', () => {
    for (let rupees = 1; rupees <= 400; rupees += 1) {
      for (const depth of [0.5, 3, 7.5, 12, 15, 18.75, 20]) {
        const list = rupeesToPaise(rupees + 0.37);
        const realised = depthPctOf(list, applyDepth(list, depth));
        expect(realised).toBeLessThanOrEqual(depth + 1e-9);
      }
    }
  });

  it('treats zero depth as list price', () => {
    const list = rupeesToPaise(4990);
    expect(applyDepth(list, 0)).toBe(list);
    expect(depthPctOf(list, list)).toBe(0);
  });

  it('rejects a depth outside 0-100', () => {
    expect(() => discountFor(paise(100), 101)).toThrow(MoneyError);
    expect(() => discountFor(paise(100), -1)).toThrow(MoneyError);
  });
});

describe('margin', () => {
  it('computes margin over revenue', () => {
    // sell at ₹100 with a ₹82 cost is an 18% margin — the envelope floor.
    expect(marginPctAt(rupeesToPaise(100), rupeesToPaise(82))).toBeCloseTo(18, 10);
  });

  it('goes negative when selling below cost', () => {
    expect(marginPctAt(rupeesToPaise(50), rupeesToPaise(80))).toBeLessThan(0);
  });
});

describe('formatting', () => {
  it('uses Indian digit grouping', () => {
    expect(formatInr(rupeesToPaise(4990))).toBe('₹4,990');
    expect(formatInr(rupeesToPaise(40000))).toBe('₹40,000');
    expect(formatInr(rupeesToPaise(120000))).toBe('₹1,20,000');
  });

  /**
   * Both paise digits, always. A trailing zero dropped from an amount of money
   * reads as a rounding error to whoever is reviewing the trail.
   */
  it('shows paise when there are any, to two digits', () => {
    expect(formatInr(rupeesToPaise(4241.5))).toBe('₹4,241.50');
    expect(formatInr(rupeesToPaise(13173.6))).toBe('₹13,173.60');
    expect(formatInr(paise(499005))).toBe('₹4,990.05');
  });

  it('omits the decimal part entirely for whole rupees', () => {
    expect(formatInr(paise(0))).toBe('₹0');
    expect(formatInr(rupeesToPaise(4990))).toBe('₹4,990');
  });

  it('formats percentages to one decimal, matching the audit row format', () => {
    expect(formatPct(15)).toBe('15.0%');
    expect(formatPct(0.12345)).toBe('0.1%');
  });
});
