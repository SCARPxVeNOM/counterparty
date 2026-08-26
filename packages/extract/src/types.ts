/**
 * The vocabulary both readers share.
 *
 * Lives apart from `extract.ts` so the storefront reader and the Payment Page
 * reader can each depend on it without depending on each other. Putting these
 * in `extract.ts` and having `razorpay-page.ts` import from there worked, but
 * only by the grace of ESM tolerating a cycle — and a cycle that happens to
 * resolve is a cycle that stops resolving the first time someone moves a call
 * to module scope.
 */

import type { CatalogEntry } from '@counterparty/core';
import type { Ambiguity } from './ambiguity';

export interface ExtractionSource {
  readonly url: string;
  readonly html: string;
  readonly fetchedAt?: Date;
}

export interface FieldReport {
  readonly field: string;
  readonly value: string | number;
  readonly confidence: number;
  readonly ambiguities: readonly Ambiguity[];
}

export interface ExtractionResult {
  readonly entry: CatalogEntry;
  /** Per-field working, so the onboarding screen can show why a score is what it is. */
  readonly reports: readonly FieldReport[];
}

export class ExtractionError extends Error {
  override readonly name = 'ExtractionError';
}
