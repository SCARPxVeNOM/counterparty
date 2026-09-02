/**
 * The demo merchant.
 *
 * Fixed keys and a fixed clock so every scenario run produces byte-identical
 * output. A demo that differs between runs cannot be diffed, and a scenario
 * suite that cannot be diffed cannot be a regression test.
 *
 * The keys below are throwaway Ed25519 keys committed on purpose so that
 * `counterparty verify` works out of the box for anyone who clones this. They
 * authorize nothing in the real world.
 */

import {
  draftMandate,
  issueMandate,
  deriveKeyPair,
  openBudget,
  publicKeyRef,
  rupeesToPaise,
  dayKeyOf,
  type BudgetState,
  type KeyPair,
  type SellingMandate,
  type SkuPricing,
} from '@counterparty/core';

export const DEMO_MERCHANT = 'Kettle & Co';
export const DEMO_MERCHANT_ID = 'acc_DEMO0001';

/** Fixed instant so signatures and offer ids are stable across runs. */
export const DEMO_NOW = new Date('2026-08-25T09:00:00+05:30');

/**
 * Demo keys, derived from visible labels rather than stored as PEMs.
 *
 * Fixed keys are what make the scenario output byte-identical across runs, so
 * it can be diffed and used as a regression test. Committing the PEM would have
 * achieved the same thing and did — until GitGuardian correctly flagged it. A
 * committed private key block is indistinguishable from a real leak until
 * someone reads the comment next to it, and training people to scroll past that
 * warning is a worse habit than the convenience is worth.
 *
 * These seeds are public and so are the keys they produce. They sign demo
 * artifacts and nothing else.
 */
export const merchantKey: KeyPair = deriveKeyPair('merchant', 'counterparty-demo-merchant-v1');
export const gateKey: KeyPair = deriveKeyPair('gate', 'counterparty-demo-gate-v1');

/**
 * The catalog.
 *
 * SKU-BLENDER-500 carries a deliberately low margin confidence — it is the SKU
 * the messy storefront fixture extracts badly, with variant pricing and a
 * struck-through MRP. Without it the confidence clause in §5.4 never fires and
 * cannot be demonstrated.
 */
export const CATALOG: ReadonlyMap<string, SkuPricing> = new Map(
  (
    [
      {
        sku: 'SKU-KETTLE-1L',
        listPrice: rupeesToPaise(4990),
        unitCost: rupeesToPaise(3400),
        marginConfidence: 0.94,
        availability: 'in_stock',
        agentPurchasable: true,
        maxQuantityPerOrder: 5,
      },
      {
        sku: 'SKU-ESPRESSO-PRO',
        listPrice: rupeesToPaise(18990),
        unitCost: rupeesToPaise(9100),
        marginConfidence: 0.91,
        availability: 'in_stock',
        agentPurchasable: true,
        maxQuantityPerOrder: 3,
      },
      {
        sku: 'SKU-BLENDER-500',
        listPrice: rupeesToPaise(3200),
        unitCost: rupeesToPaise(2100),
        marginConfidence: 0.41,
        availability: 'in_stock',
        agentPurchasable: true,
        maxQuantityPerOrder: 5,
      },
      {
        sku: 'SKU-CLEARANCE-TOASTER',
        listPrice: rupeesToPaise(1490),
        unitCost: rupeesToPaise(1200),
        marginConfidence: 0.88,
        availability: 'in_stock',
        agentPurchasable: true,
        maxQuantityPerOrder: 2,
      },
    ] satisfies SkuPricing[]
  ).map((sku) => [sku.sku, sku]),
);

export function demoMandate(overrides?: Parameters<typeof draftMandate>[0]['authority']): SellingMandate {
  return issueMandate(
    draftMandate({
      merchantId: DEMO_MERCHANT_ID,
      gateKey: publicKeyRef(gateKey),
      envelopeId: 'env_demo_0001',
      issuedAt: DEMO_NOW,
      ...(overrides === undefined ? {} : { authority: overrides }),
    }),
    merchantKey,
    DEMO_NOW,
  );
}

export function demoBudget(): BudgetState {
  return openBudget(rupeesToPaise(40000), dayKeyOf(DEMO_NOW));
}

export { ScriptedSeller } from './scripted-seller';

export { syntheticHaltedCohort, syntheticLapsedAuthorizations } from './halted-cohort';

export {
  CONSOLE_CASSETTE_DIR,
  CONSOLE_FOLLOW_UPS,
  CONSOLE_SESSION_ID,
  consoleTurns,
} from './console-script';
