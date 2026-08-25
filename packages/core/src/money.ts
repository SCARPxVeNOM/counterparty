/**
 * Money.
 *
 * Every internal amount in this system is an integer number of paise. Razorpay's
 * API is denominated in paise, discount arithmetic on rupee floats accumulates
 * error, and a payments demo that is off by a rupee is a payments demo that
 * loses. The branded type means a bare `number` cannot be passed where an amount
 * is expected without going through one of the constructors below.
 *
 * Envelope fields authored by a human are in rupees and carry an `_inr` suffix.
 * They are converted exactly once, at load.
 */

export type Paise = number & { readonly __paise: unique symbol };

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

export function paise(value: number): Paise {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`paise must be a whole number, got ${value}`);
  }
  if (value < 0) {
    throw new MoneyError(`paise must not be negative, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`amount is too large to represent exactly: ${value}`);
  }
  return value as Paise;
}

export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) {
    throw new MoneyError(`rupees must be finite, got ${rupees}`);
  }
  // Multiply then round, rather than rounding a float product, so that values
  // like 4990.05 do not land a paisa low from binary representation.
  return paise(Math.round(rupees * 100));
}

export function paiseToRupees(amount: Paise): number {
  return amount / 100;
}

export const ZERO = paise(0);

export function addPaise(a: Paise, b: Paise): Paise {
  return paise(a + b);
}

export function subPaise(a: Paise, b: Paise): Paise {
  if (b > a) {
    throw new MoneyError(`subtracting ${b} from ${a} would produce a negative amount`);
  }
  return paise(a - b);
}

export function mulPaise(amount: Paise, factor: number): Paise {
  return paise(Math.round(amount * factor));
}

export function minPaise(a: Paise, b: Paise): Paise {
  return a <= b ? a : b;
}

/**
 * The discount implied by a depth percentage, rounded DOWN.
 *
 * Rounding direction is a policy decision, not an implementation detail. Down
 * means the buyer never receives a fraction of a paisa more than the mandate
 * authorized, so the realised depth is always <= the authorized depth. Rounding
 * the other way would let a 15.00% ceiling settle at 15.0001% and produce audit
 * rows that contradict the clause they cite.
 */
export function discountFor(listPrice: Paise, depthPct: number): Paise {
  assertPct(depthPct, 'depth');
  return paise(Math.floor((listPrice * depthPct) / 100));
}

/** List price less the discount implied by `depthPct`. */
export function applyDepth(listPrice: Paise, depthPct: number): Paise {
  return subPaise(listPrice, discountFor(listPrice, depthPct));
}

/** The depth an offered price actually represents, as a percentage of list. */
export function depthPctOf(listPrice: Paise, offeredPrice: Paise): number {
  if (listPrice === 0) return 0;
  return ((listPrice - offeredPrice) / listPrice) * 100;
}

/**
 * Margin percentage at a given selling price, given unit cost.
 * Expressed as margin over revenue, which is the convention `floor_margin_pct`
 * in the envelope uses.
 */
export function marginPctAt(sellingPrice: Paise, unitCost: Paise): number {
  if (sellingPrice === 0) return 0;
  return ((sellingPrice - unitCost) / sellingPrice) * 100;
}

function assertPct(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new MoneyError(`${label} percentage must be between 0 and 100, got ${value}`);
  }
}

const INR = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/**
 * Indian digit grouping — ₹1,20,000 rather than ₹120,000. Whole rupees print
 * without a decimal part, matching the audit row format in the design.
 */
export function formatInr(amount: Paise): string {
  return `₹${INR.format(amount / 100)}`;
}

/** Percentages in audit rows always show one decimal place: "15.0%". */
export function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}
