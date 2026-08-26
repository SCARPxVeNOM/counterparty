/**
 * Reading a Razorpay-hosted Payment Page.
 *
 * WHY THIS IS A SEPARATE READER.
 *
 * `extractEntry` scrapes a human storefront: class names, a `SKU:` line, rupee
 * amounts in the markup. Pointed at a real Razorpay Payment Page it throws
 * immediately, and it is right to — the page has no SKU, no `.price` element,
 * and no product text of any kind. Its entire body is:
 *
 *     <div id="paymentpage-container"></div>
 *
 * Everything visible is rendered client-side. A crawler reading rendered text
 * would find nothing at all; a crawler reading the HTML finds an empty shell.
 *
 * But the page is not hiding the data — it ships it, in a JSON object between
 * two markers Razorpay puts there on purpose:
 *
 *     // <<<JSON_DATA_START>>>
 *     var data = { ... }
 *     // <<<JSON_DATA_END>>>
 *
 * So the right reader is not a better scraper, it is a different one. And the
 * structured source deserves a structured confidence: there is exactly one
 * authoritative amount, in paise, in a typed field. No struck-through MRP, no
 * variant table, nothing to be ambiguous about. Price confidence is high and
 * says so.
 *
 * THE FINDING THAT MATTERS.
 *
 * The page carries no unit cost. Not because Razorpay omitted it — because a
 * customer-facing page never states what the merchant paid. That is not a
 * defect in this reader, it is the ordinary condition of every storefront on
 * the internet, and it means margin cannot be established from a public page at
 * all.
 *
 * So `cost_absent` fires, cost confidence collapses to ~0.05, and the gate
 * refuses any discount on this SKU citing
 * `confidence_policy.min_margin_confidence` until a human supplies the cost.
 * The synthetic messy fixture demonstrates the same clause via manufactured
 * ambiguity; this demonstrates it for the reason it will actually happen.
 */

import { CatalogEntrySchema, type Provenance } from '@counterparty/core';
import { confidenceFrom, type Ambiguity } from './ambiguity';
import { ExtractionError, type ExtractionResult, type ExtractionSource } from './types';

const JSON_START = '<<<JSON_DATA_START>>>';
const JSON_END = '<<<JSON_DATA_END>>>';

/** Cheap enough to run on every source before deciding which reader to use. */
export function isRazorpayPaymentPage(html: string): boolean {
  return html.includes(JSON_START) && html.includes('paymentpage-container');
}

interface PaymentPageItem {
  readonly item?: {
    readonly name?: string;
    readonly description?: string | null;
    readonly amount?: number;
    readonly unit_amount?: number;
    readonly currency?: string;
  };
  readonly quantity_available?: number | null;
  readonly min_purchase?: number | null;
  readonly max_purchase?: number | null;
}

interface PaymentPageData {
  readonly key_id?: string;
  readonly is_test_mode?: boolean;
  readonly merchant?: { readonly id?: string; readonly name?: string };
  readonly payment_link?: {
    readonly id?: string;
    readonly title?: string;
    readonly description?: string | null;
    readonly amount?: number;
    readonly currency?: string;
    readonly status?: string;
    readonly short_url?: string;
    readonly payment_page_items?: readonly PaymentPageItem[];
  };
}

/**
 * The embedded object, parsed.
 *
 * Sliced between the markers rather than regex-matched across the whole file:
 * the payload contains escaped quotes, nested JSON-in-strings and a trailing
 * `;`, and a pattern loose enough to survive all three is loose enough to match
 * the wrong thing.
 */
export function parsePaymentPageData(html: string): PaymentPageData {
  const from = html.indexOf(JSON_START);
  const to = html.indexOf(JSON_END);
  if (from === -1 || to === -1 || to < from) {
    throw new ExtractionError('not a Razorpay Payment Page: no JSON_DATA markers');
  }

  const block = html.slice(from + JSON_START.length, to);

  // Bound the object by its own braces rather than by trimming what surrounds
  // it. The block is not just `var data = {...}` — it opens with the tail of the
  // start-marker line and closes with `;` plus the `// ` that prefixes the end
  // marker, and a trailing-semicolon regex silently leaves that comment behind.
  // First `{` to last `}` needs no such guesswork.
  const opens = block.indexOf('{');
  const closes = block.lastIndexOf('}');
  if (opens === -1 || closes < opens) {
    throw new ExtractionError('Payment Page data block contains no JSON object');
  }

  const raw = block.slice(opens, closes + 1);
  try {
    return JSON.parse(raw) as PaymentPageData;
  } catch (cause) {
    throw new ExtractionError(`could not parse Payment Page data: ${(cause as Error).message}`);
  }
}

function provenance(source: ExtractionSource, snippet: string, confidence: number): Provenance {
  return {
    source_url: source.url,
    snippet: snippet.slice(0, 300),
    crawled_at: (source.fetchedAt ?? new Date()).toISOString(),
    confidence,
  };
}

/**
 * A structured source has structured confidence.
 *
 * Not 1.0 even so. The number is read correctly, but "the merchant charges
 * ₹1,000 on this page" is not the same claim as "₹1,000 is this SKU's list
 * price" — a Payment Page can be a deposit, an instalment, or one of several
 * pages for the same product. Above `min_margin_confidence`, below certainty.
 */
export const STRUCTURED_PRICE_CONFIDENCE = 0.97;

/**
 * Build a catalog entry from a Razorpay Payment Page.
 *
 * `skuHint` exists because the page has no SKU and cannot have one — Payment
 * Pages identify a *page*, not a product. Passing one is the merchant saying
 * which of their SKUs this page sells; without it the page id is used, which is
 * honest but useless for matching against a catalog.
 */
export function extractFromPaymentPage(
  source: ExtractionSource,
  skuHint?: string,
): ExtractionResult {
  const data = parsePaymentPageData(source.html);
  const link = data.payment_link;
  if (link === undefined) {
    throw new ExtractionError(`no payment_link object at ${source.url}`);
  }

  const pageId = link.id ?? 'pl_unknown';
  const sku = skuHint ?? `SKU-${pageId.toUpperCase()}`;
  const firstItem = link.payment_page_items?.[0]?.item;

  // Paise in the payload, rupees in the catalog. The page is authoritative
  // about the former and silent about rounding, so integer division would
  // quietly lose a half-rupee page; this keeps it and lets zod complain.
  const amountPaise = firstItem?.unit_amount ?? firstItem?.amount ?? link.amount;
  if (amountPaise === undefined) {
    throw new ExtractionError(`no amount on Payment Page ${pageId}`);
  }
  const listPrice = amountPaise / 100;

  const currency = firstItem?.currency ?? link.currency ?? 'INR';
  if (currency !== 'INR') {
    throw new ExtractionError(`Payment Page ${pageId} is in ${currency}; this system is INR-only`);
  }

  const title = link.title ?? firstItem?.name ?? pageId;

  const priceAmbiguities: Ambiguity[] = [];
  const priceConfidence = STRUCTURED_PRICE_CONFIDENCE;

  /**
   * The universal fact about customer-facing pages, stated as evidence rather
   * than assumed: nobody publishes what their stock cost them.
   */
  const costAmbiguities: Ambiguity[] = [
    {
      kind: 'cost_absent',
      evidence: `payment_page_item ${link.payment_page_items?.[0]?.item?.name ?? 'Amount'} — amount only`,
      note: 'a Payment Page states what the customer pays, never what the merchant paid',
    },
  ];
  const costConfidence = confidenceFrom(costAmbiguities);

  const availability = link.status === 'active' ? 'in_stock' : 'discontinued';

  const entry = CatalogEntrySchema.parse({
    sku,
    title: {
      value: title,
      provenance: provenance(source, `payment_link.title = ${JSON.stringify(title)}`, 0.95),
    },
    description: {
      value: link.description ?? firstItem?.description ?? '',
      provenance: provenance(source, 'payment_link.description', 0.9),
    },
    list_price_inr: {
      value: listPrice,
      provenance: provenance(
        source,
        `payment_page_item.unit_amount = ${amountPaise} paise (${currency})`,
        priceConfidence,
      ),
    },
    unit_cost_inr: {
      value: 0,
      provenance: provenance(source, costAmbiguities[0]?.evidence ?? '', costConfidence),
    },
    availability: {
      value: availability,
      provenance: provenance(source, `payment_link.status = ${link.status ?? 'unknown'}`, 0.93),
    },
    agent_terms: {
      agent_purchasable: true,
      requires_human_confirmation: false,
      max_quantity_per_order: link.payment_page_items?.[0]?.max_purchase ?? 5,
      returns_window_days: 7,
      protocols: ['acp', 'ap2', 'upi-uap'],
    },
  });

  return {
    entry,
    reports: [
      {
        field: 'list_price_inr',
        value: listPrice,
        confidence: priceConfidence,
        ambiguities: priceAmbiguities,
      },
      {
        field: 'unit_cost_inr',
        value: 0,
        confidence: costConfidence,
        ambiguities: costAmbiguities,
      },
    ],
  };
}
