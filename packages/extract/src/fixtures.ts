/**
 * Saved storefront pages.
 *
 * Extraction is real, but a demo that depends on a live third-party site is a
 * demo that can fail for reasons unrelated to what it is demonstrating. These
 * three pages ship with the repo so the onboarding path is deterministic and
 * offline; a live URL still works and goes through exactly the same code.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtractionSource } from './extract';

export const FIXTURES = {
  kettle: {
    file: 'kettle.html',
    url: 'https://kettleandco.example/products/1-5l-electric-kettle',
    note: 'clean page — one price, cost present and unqualified',
  },
  espresso: {
    file: 'espresso.html',
    url: 'https://kettleandco.example/products/espresso-pro-15-bar',
    note: 'clean page',
  },
  blender: {
    file: 'blender-messy.html',
    url: 'https://kettleandco.example/products/500w-mixer-grinder-3-jar',
    note: 'messy page — struck-through MRP, "from" teaser, variant table, offer copy, stale cost',
  },
} as const;

export type FixtureName = keyof typeof FIXTURES;

function fixtureDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
}

export function loadFixture(name: FixtureName, fetchedAt?: Date): ExtractionSource {
  const fixture = FIXTURES[name];
  return {
    url: fixture.url,
    html: readFileSync(join(fixtureDir(), fixture.file), 'utf8'),
    ...(fetchedAt === undefined ? {} : { fetchedAt }),
  };
}

/** Fetch a live storefront. Same pipeline, same confidence scoring. */
export async function fetchSource(url: string): Promise<ExtractionSource> {
  const response = await fetch(url, { headers: { 'User-Agent': 'counterparty-onboarding/0.1' } });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return { url, html: await response.text(), fetchedAt: new Date() };
}
