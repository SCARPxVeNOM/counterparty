import { generateKeyPair, publicKeyRef, type KeyPair } from '../../src/crypto/keys.js';
import { draftMandate } from '../../src/mandate/draft.js';
import { issueMandate } from '../../src/mandate/issue.js';
import type { SellingMandate, UnsignedMandate } from '../../src/mandate/schema.js';
import { openBudget, dayKeyOf, type BudgetState } from '../../src/budget/ledger.js';
import { INITIAL_PRESSURE, type PressureSnapshot } from '../../src/pressure/reduce.js';
import { rupeesToPaise } from '../../src/money.js';
import type { SkuPricing } from '../../src/catalog/schema.js';
import type { GateContext } from '../../src/gate/evaluate.js';

export const merchantKey: KeyPair = generateKeyPair('merchant');
export const gateKey: KeyPair = generateKeyPair('gate');

export const NOW = new Date('2026-08-25T09:00:00+05:30');

/**
 * A ₹4,990 kettle costing ₹3,400 — a 31.9% margin at list, so an 18% floor
 * leaves genuine room to concede without the fixture doing the work the gate
 * is supposed to do.
 */
export const KETTLE: SkuPricing = {
  sku: 'SKU-KETTLE-1L',
  listPrice: rupeesToPaise(4990),
  unitCost: rupeesToPaise(3400),
  marginConfidence: 0.94,
  availability: 'in_stock',
  agentPurchasable: true,
  maxQuantityPerOrder: 5,
};

/**
 * A 51.9% list margin — fat enough that the 20% bundle ceiling is actually
 * reachable at an 18% floor. Reaching a 20% depth while keeping 18% margin
 * requires a list margin of at least 34.4%, which the kettle does not have.
 */
export const PREMIUM: SkuPricing = {
  sku: 'SKU-ESPRESSO-PRO',
  listPrice: rupeesToPaise(4990),
  unitCost: rupeesToPaise(2400),
  marginConfidence: 0.96,
  availability: 'in_stock',
  agentPurchasable: true,
  maxQuantityPerOrder: 5,
};

/** The messy-extraction SKU: cost read with low confidence. */
export const BLENDER_LOW_CONFIDENCE: SkuPricing = {
  sku: 'SKU-BLENDER-500',
  listPrice: rupeesToPaise(3200),
  unitCost: rupeesToPaise(2100),
  marginConfidence: 0.41,
  availability: 'in_stock',
  agentPurchasable: true,
  maxQuantityPerOrder: 5,
};

/** Thin margin: costs ₹4,300 against a ₹4,990 list, so 13.8% margin at list. */
export const THIN_MARGIN: SkuPricing = {
  sku: 'SKU-TOASTER-2S',
  listPrice: rupeesToPaise(4990),
  unitCost: rupeesToPaise(4300),
  marginConfidence: 0.95,
  availability: 'in_stock',
  agentPurchasable: true,
  maxQuantityPerOrder: 5,
};

export const CLEARANCE: SkuPricing = {
  ...KETTLE,
  sku: 'SKU-CLEARANCE-KETTLE',
};

export const OUT_OF_STOCK: SkuPricing = {
  ...KETTLE,
  sku: 'SKU-MIXER-750',
  availability: 'out_of_stock',
};

export const NOT_AGENT_PURCHASABLE: SkuPricing = {
  ...KETTLE,
  sku: 'SKU-GIFTCARD-1000',
  agentPurchasable: false,
};

export const PRICING: ReadonlyMap<string, SkuPricing> = new Map(
  [
    KETTLE,
    PREMIUM,
    BLENDER_LOW_CONFIDENCE,
    THIN_MARGIN,
    CLEARANCE,
    OUT_OF_STOCK,
    NOT_AGENT_PURCHASABLE,
  ].map((entry) => [entry.sku, entry]),
);

export function mandateWith(overrides?: Partial<Parameters<typeof draftMandate>[0]>): SellingMandate {
  const draft: UnsignedMandate = draftMandate({
    merchantId: 'acc_TEST0001',
    gateKey: publicKeyRef(gateKey),
    issuedAt: NOW,
    envelopeId: 'env_test',
    ...overrides,
  });
  return issueMandate(draft, merchantKey, NOW);
}

export function freshBudget(): BudgetState {
  return openBudget(rupeesToPaise(40000), dayKeyOf(NOW));
}

export interface ContextOverrides {
  readonly mandate?: SellingMandate;
  readonly budget?: BudgetState;
  readonly pressure?: PressureSnapshot;
  readonly now?: Date;
  readonly gateKey?: KeyPair;
  readonly offerId?: string;
}

export function contextWith(overrides: ContextOverrides = {}): GateContext {
  return {
    mandate: overrides.mandate ?? mandateWith(),
    gateKey: overrides.gateKey ?? gateKey,
    pricing: PRICING,
    budget: overrides.budget ?? freshBudget(),
    pressure: overrides.pressure ?? INITIAL_PRESSURE,
    now: overrides.now ?? NOW,
    offerId: overrides.offerId ?? 'off_test_0001',
  };
}
