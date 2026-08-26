/**
 * Onboarding: read a page, return the working.
 *
 * Extraction runs on the server because it fetches arbitrary URLs, and a
 * browser doing that hits CORS on every real storefront. The response carries
 * the per-field confidence AND the evidence behind it — a score with no
 * evidence beside it is a number the merchant has to take on faith, and taking
 * margin authority on faith is the failure this whole system exists to prevent.
 */

import { NextResponse } from 'next/server';
import {
  FIXTURES,
  fetchSource,
  isRazorpayPaymentPage,
  loadFixture,
  readSource,
  type ExtractionSource,
  type FixtureName,
} from '@counterparty/extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Matches confidence_policy.min_margin_confidence in the demo envelope. */
const MIN_MARGIN_CONFIDENCE = 0.85;

export interface OnboardResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly source?: {
    readonly url: string;
    readonly kind: 'razorpay_payment_page' | 'storefront';
    readonly bytes: number;
  };
  readonly entry?: {
    readonly sku: string;
    readonly title: string;
    readonly listPriceInr: number;
    readonly unitCostInr: number;
    readonly availability: string;
  };
  readonly fields?: readonly {
    readonly field: string;
    readonly value: string | number;
    readonly confidence: number;
    readonly snippet: string;
    readonly crawledAt: string;
    readonly ambiguities: readonly { kind: string; note: string; evidence: string }[];
  }[];
  readonly authority?: {
    readonly maxDiscountDepthPct: number | 'envelope ceiling';
    readonly clause: string | null;
    readonly reason: string;
  };
}

export async function POST(request: Request): Promise<NextResponse<OnboardResponse>> {
  let body: { target?: string; sku?: string };
  try {
    body = (await request.json()) as { target?: string; sku?: string };
  } catch {
    return NextResponse.json({ ok: false, error: 'malformed request body' }, { status: 400 });
  }

  const target = body.target?.trim() ?? '';
  if (target === '') {
    return NextResponse.json({ ok: false, error: 'no URL or fixture given' }, { status: 400 });
  }

  let source: ExtractionSource;
  try {
    if (/^https?:\/\//i.test(target)) {
      source = await fetchSource(target);
    } else if (target in FIXTURES) {
      source = loadFixture(target as FixtureName);
    } else {
      return NextResponse.json(
        { ok: false, error: `unknown fixture "${target}"` },
        { status: 400 },
      );
    }
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `could not read ${target}: ${(error as Error).message}` },
      { status: 502 },
    );
  }

  let result;
  try {
    result = readSource(source, body.sku?.trim() === '' ? undefined : body.sku?.trim());
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: (error as Error).message, source: describe(source) },
      { status: 422 },
    );
  }

  const entry = result.entry;
  const costConfidence =
    result.reports.find((r) => r.field === 'unit_cost_inr')?.confidence ?? 0;
  const blocked = costConfidence < MIN_MARGIN_CONFIDENCE;

  return NextResponse.json({
    ok: true,
    source: describe(source),
    entry: {
      sku: entry.sku,
      title: String(entry.title.value),
      listPriceInr: Number(entry.list_price_inr.value),
      unitCostInr: Number(entry.unit_cost_inr.value),
      availability: String(entry.availability.value),
    },
    fields: result.reports.map((report) => {
      const field = report.field === 'list_price_inr' ? entry.list_price_inr : entry.unit_cost_inr;
      return {
        field: report.field,
        value: report.value,
        confidence: report.confidence,
        snippet: field.provenance.snippet,
        crawledAt: field.provenance.crawled_at,
        ambiguities: report.ambiguities.map((a) => ({
          kind: a.kind,
          note: a.note,
          evidence: a.evidence,
        })),
      };
    }),
    authority: {
      maxDiscountDepthPct: blocked ? 0 : 'envelope ceiling',
      clause: blocked ? 'confidence_policy.min_margin_confidence' : null,
      reason: blocked
        ? `unit_cost confidence ${costConfidence.toFixed(3)} is below ${MIN_MARGIN_CONFIDENCE} — ` +
          'the agent may not discount what it cannot prove it can afford to discount'
        : `unit_cost confidence ${costConfidence.toFixed(3)} clears ${MIN_MARGIN_CONFIDENCE}`,
    },
  });
}

function describe(source: ExtractionSource): NonNullable<OnboardResponse['source']> {
  return {
    url: source.url,
    kind: isRazorpayPaymentPage(source.html) ? 'razorpay_payment_page' : 'storefront',
    bytes: source.html.length,
  };
}

/** The fixture list, so the screen does not hardcode its own copy. */
export function GET(): NextResponse {
  return NextResponse.json({
    fixtures: Object.entries(FIXTURES).map(([name, f]) => ({
      name,
      url: f.url,
      note: f.note,
    })),
  });
}
