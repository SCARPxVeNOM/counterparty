import { describe, expect, it } from 'vitest';
import {
  INITIAL_PRESSURE,
  dayKeyOf,
  draftMandate,
  evaluateQuote,
  generateKeyPair,
  issueMandate,
  openBudget,
  pricingOf,
  publicKeyRef,
  rupeesToPaise,
  type SkuPricing,
} from '@counterparty/core';
import { extractEntry } from '../src/extract';
import { readSource } from '../src/extract';
import { loadFixture } from '../src/fixtures';
import {
  extractFromPaymentPage,
  isRazorpayPaymentPage,
  parsePaymentPageData,
} from '../src/razorpay-page';
import { ExtractionError } from '../src/types';

const NOW = new Date('2026-08-26T13:00:00Z');
const page = () => loadFixture('razorpayPage', NOW);

/**
 * This fixture is the only one in the repo we did not write. It is a real
 * Razorpay Payment Page, fetched over plain HTTP, with a session token and a
 * phone number redacted and nothing else touched.
 */
describe('a real Razorpay Payment Page', () => {
  it('is recognised as one', () => {
    expect(isRazorpayPaymentPage(page().html)).toBe(true);
    expect(isRazorpayPaymentPage(loadFixture('kettle', NOW).html)).toBe(false);
  });

  /**
   * The finding that justifies a second reader existing at all. The page has no
   * product markup — its body is a single empty div — so the storefront scraper
   * cannot read it, and fails describing itself rather than the page.
   */
  it('defeats the storefront scraper entirely', () => {
    expect(page().html).toContain('<div id="paymentpage-container">');
    expect(() => extractEntry(page())).toThrow(ExtractionError);
    expect(() => extractEntry(page())).toThrow(/no SKU/i);
  });

  it('carries its data as JSON rather than markup', () => {
    const data = parsePaymentPageData(page().html);
    expect(data.payment_link?.id).toBe('pl_TUTJpXRxhr1dfQ');
    expect(data.payment_link?.title).toBe('testpage');
    expect(data.is_test_mode).toBe(true);
  });

  /**
   * The block between the markers ends with `;` and the `// ` that prefixes the
   * closing marker. Bounding the object by its own braces survives that; a
   * trailing-semicolon trim did not, and failed with a JSON error 2,664
   * characters from anything a reader would suspect.
   */
  it('parses despite the comment prefix trailing the payload', () => {
    const between = page().html.slice(
      page().html.indexOf('<<<JSON_DATA_START>>>'),
      page().html.indexOf('<<<JSON_DATA_END>>>'),
    );
    expect(between.trimEnd().endsWith('//')).toBe(true);
    expect(() => parsePaymentPageData(page().html)).not.toThrow();
  });

  it('rejects a page with no data block', () => {
    expect(() => parsePaymentPageData('<html><body>nothing</body></html>')).toThrow(ExtractionError);
  });
});

describe('extracting from the real page', () => {
  const result = extractFromPaymentPage(page(), 'SKU-TESTPAGE');

  it('reads the price from the structured payload, in rupees', () => {
    expect(result.entry.list_price_inr.value).toBe(1000);
    expect(result.entry.list_price_inr.provenance.snippet).toContain('100000 paise');
  });

  it('is confident about the price, because there is nothing to be unsure of', () => {
    const price = result.reports.find((r) => r.field === 'list_price_inr');
    expect(price?.ambiguities).toHaveLength(0);
    expect(price?.confidence).toBeGreaterThan(0.9);
  });

  /**
   * The point of the whole fixture. No customer-facing page states what the
   * merchant paid — not this one, not any of them. So margin cannot be
   * established from a public page, and the confidence says so rather than
   * quietly defaulting to something workable.
   */
  it('finds no unit cost, and collapses cost confidence accordingly', () => {
    const cost = result.reports.find((r) => r.field === 'unit_cost_inr');
    expect(result.entry.unit_cost_inr.value).toBe(0);
    expect(cost?.ambiguities.map((a) => a.kind)).toEqual(['cost_absent']);
    expect(cost?.confidence).toBeLessThan(0.1);
  });

  it('carries the page id when the merchant names no SKU', () => {
    expect(extractFromPaymentPage(page()).entry.sku).toBe('SKU-PL_TUTJPXRXHR1DFQ');
  });

  it('reads title and availability from the payload', () => {
    expect(result.entry.title.value).toBe('testpage');
    expect(result.entry.availability.value).toBe('in_stock');
  });

  it('is reached automatically by readSource', () => {
    expect(readSource(page(), 'SKU-TESTPAGE').entry.list_price_inr.value).toBe(1000);
  });
});

/**
 * End to end, on bytes we did not author: a real page yields an untrustworthy
 * margin, that confidence rides into the catalog on the field's own provenance,
 * and the gate refuses to discount citing the clause by name.
 *
 * The synthetic blender fixture proves the same clause fires. This proves it
 * fires for the reason it will actually fire in production.
 */
describe('the real page, through the gate', () => {
  const merchantKey = generateKeyPair('merchant');
  const gateKey = generateKeyPair('gate');
  const mandate = issueMandate(
    draftMandate({ merchantId: 'acc_X', gateKey: publicKeyRef(gateKey), issuedAt: NOW }),
    merchantKey,
    NOW,
  );

  const entry = extractFromPaymentPage(page(), 'SKU-TESTPAGE').entry;
  const pricing = new Map<string, SkuPricing>([['SKU-TESTPAGE', pricingOf(entry)]]);

  function quote(depthPct: number) {
    return evaluateQuote(
      {
        kind: 'quote',
        buyerId: 'buyer_a',
        lines: [{ sku: 'SKU-TESTPAGE', quantity: 1 }],
        requestedDepthPct: depthPct,
        rationale: 'test',
      },
      {
        mandate,
        gateKey,
        pricing,
        budget: openBudget(rupeesToPaise(40000), dayKeyOf(NOW)),
        pressure: INITIAL_PRESSURE,
        now: NOW,
        offerId: 'off_testpage',
      },
    );
  }

  it('refuses any discount, citing the confidence clause', () => {
    const decision = quote(5);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.clause).toBe('confidence_policy.min_margin_confidence');
    }
  });

  it('still sells it at list price', () => {
    const decision = quote(0);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.offer.offered_total_inr).toBe(1000);
    }
  });
});
