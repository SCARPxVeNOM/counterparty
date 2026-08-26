/**
 * Onboarding extraction.
 *
 *   Storefront ──▶ crawl + extract ──▶ draft catalog + draft envelope ──▶ merchant confirms
 *    (human-facing)  (provenance per field)   (confidence scored)          (one screen)
 *
 * The selling agent cannot negotiate without knowing what it sells and at what
 * margin, and long-tail merchants have that in no structured form. Platform
 * merchants get agent-readability free; everyone else gets nothing.
 *
 * Every extracted field carries source URL, the snippet it came from, the crawl
 * timestamp and a confidence score. The confidence is not the model's opinion of
 * itself — see ambiguity.ts. It is computed from countable ambiguity in the
 * source, so a merchant reviewing the draft can see exactly which line of their
 * own storefront cost them discount authority.
 */

import {
  CatalogEntrySchema,
  CatalogSchema,
  type Catalog,
  type CatalogEntry,
  type Provenance,
} from '@counterparty/core';
import { confidenceFrom, costAmbiguities, priceAmbiguities, rupeeAmounts } from './ambiguity';
import { isRazorpayPaymentPage, extractFromPaymentPage } from './razorpay-page';
import {
  ExtractionError,
  type ExtractionResult,
  type ExtractionSource,
  type FieldReport,
} from './types';

export {
  ExtractionError,
  type ExtractionResult,
  type ExtractionSource,
  type FieldReport,
} from './types';

/** Text of the first element matching a class, tags stripped. */
function textOfClass(html: string, className: string): string | null {
  const match = new RegExp(`<[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<`, 'i').exec(html);
  return match?.[1]?.trim() ?? null;
}

function textOfTag(html: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html);
  return match?.[1]?.replace(/<[^>]*>/g, '').trim() ?? null;
}

function snippetAround(html: string, needle: string, span = 160): string {
  const at = html.indexOf(needle);
  if (at === -1) return needle;
  const from = Math.max(0, at - span / 2);
  return html
    .slice(from, at + needle.length + span / 2)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
 * Pull one product record out of a storefront page.
 *
 * The parsing here is intentionally simple — class names, a SKU line, rupee
 * amounts, a cost data attribute. A model would read a wider variety of pages,
 * and `extractWithModel` below is where that goes. What matters for the design
 * is that whichever one reads the page, the CONFIDENCE is computed the same way
 * afterwards, from the source itself.
 */
export function extractEntry(source: ExtractionSource): ExtractionResult {
  const { html } = source;

  const skuLine = /SKU:\s*([A-Z0-9-]+)/i.exec(html);
  const sku = skuLine?.[1];
  if (sku === undefined) {
    throw new ExtractionError(`no SKU found at ${source.url}`);
  }

  const title = textOfClass(html, 'product-title') ?? textOfTag(html, 'h1') ?? sku;

  // --- price -------------------------------------------------------------
  const pricingBlock = /<div[^>]*class="[^"]*\bpricing\b[^"]*"[\s\S]*?<\/div>/i.exec(html)?.[0] ?? html;
  const priceProblems = priceAmbiguities(html);
  const priceConfidence = confidenceFrom(priceProblems);

  // The `.price` element when there is one, else the first amount in the block.
  const labelled = /class="[^"]*\bprice\b[^"]*"[^>]*>\s*₹\s?([\d,]+)/i.exec(pricingBlock)?.[1];
  const candidates = rupeeAmounts(pricingBlock);
  const listPrice = labelled !== undefined ? Number(labelled.replace(/,/g, '')) : candidates[0];
  if (listPrice === undefined) {
    throw new ExtractionError(`no price found for ${sku} at ${source.url}`);
  }

  // --- cost --------------------------------------------------------------
  const costProblems = costAmbiguities(html);
  const costConfidence = confidenceFrom(costProblems);
  const costRaw = /data-unit-cost="(\d+)"/i.exec(html)?.[1];
  const unitCost = costRaw === undefined ? 0 : Number(costRaw);

  // --- availability ------------------------------------------------------
  const availabilityText = textOfClass(html, 'availability') ?? '';
  const availability = /out of stock|sold out/i.test(availabilityText)
    ? 'out_of_stock'
    : /pre-?order/i.test(availabilityText)
      ? 'preorder'
      : /discontinued/i.test(availabilityText)
        ? 'discontinued'
        : 'in_stock';

  const description = textOfClass(html, 'description') ?? '';

  const entry = CatalogEntrySchema.parse({
    sku,
    title: {
      value: title,
      provenance: provenance(source, snippetAround(html, title), 0.95),
    },
    description: {
      value: description,
      provenance: provenance(source, snippetAround(html, description.slice(0, 40)), 0.9),
    },
    list_price_inr: {
      value: listPrice,
      provenance: provenance(source, snippetAround(html, pricingBlock.slice(0, 60)), priceConfidence),
    },
    unit_cost_inr: {
      value: unitCost,
      provenance: provenance(
        source,
        costProblems.length === 0
          ? `data-unit-cost="${unitCost}"`
          : (costProblems[0]?.evidence ?? 'cost not found'),
        costConfidence,
      ),
    },
    availability: {
      value: availability,
      provenance: provenance(source, availabilityText, availabilityText === '' ? 0.4 : 0.93),
    },
    agent_terms: {
      agent_purchasable: true,
      requires_human_confirmation: false,
      max_quantity_per_order: 5,
      returns_window_days: 7,
      /**
       * AOCF's protocol enum has no UPI at all — a format for agent commerce
       * that cannot describe the rails most Indian merchants settle on. `upi-uap`
       * is our extension, with mandate semantics mirroring UPI Circle's
       * delegated, spending-capped authority.
       */
      protocols: ['acp', 'ap2', 'upi-uap'],
    },
  });

  return {
    entry,
    reports: [
      { field: 'list_price_inr', value: listPrice, confidence: priceConfidence, ambiguities: priceProblems },
      { field: 'unit_cost_inr', value: unitCost, confidence: costConfidence, ambiguities: costProblems },
    ],
  };
}

/**
 * Read a page with whichever reader suits it.
 *
 * A Razorpay-hosted Payment Page is an empty SPA shell carrying a JSON payload;
 * a human storefront is markup. Scraping the first or JSON-parsing the second
 * both fail, and the failure from the wrong reader ("no SKU found") describes
 * the reader rather than the page. Dispatch on what the bytes actually are.
 *
 * `skuHint` only reaches the Payment Page reader, which needs it because a
 * Payment Page identifies a page rather than a product. Storefronts carry their
 * own SKU and ignore it.
 */
export function readSource(source: ExtractionSource, skuHint?: string): ExtractionResult {
  return isRazorpayPaymentPage(source.html)
    ? extractFromPaymentPage(source, skuHint)
    : extractEntry(source);
}

export interface CatalogExtraction {
  readonly catalog: Catalog;
  readonly reports: ReadonlyMap<string, readonly FieldReport[]>;
}

export function extractCatalog(
  merchantId: string,
  sources: readonly ExtractionSource[],
): CatalogExtraction {
  const entries: CatalogEntry[] = [];
  const reports = new Map<string, readonly FieldReport[]>();

  for (const source of sources) {
    const result = readSource(source);
    entries.push(result.entry);
    reports.set(result.entry.sku, result.reports);
  }

  const catalog = CatalogSchema.parse({
    merchant_id: merchantId,
    source_url: sources[0]?.url ?? '',
    extracted_at: new Date().toISOString(),
    entries,
  });

  return { catalog, reports };
}
