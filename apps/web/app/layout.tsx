import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

/**
 * Two faces from one family, doing two different jobs.
 *
 * IBM Plex Sans carries the interface — labels, headings, prose, controls.
 * IBM Plex Mono carries anything a reader might need to compare, copy or
 * distrust: amounts, percentages, key ids, signatures, hashes, clause paths.
 *
 * That split is the convention every serious financial interface follows, and
 * the earlier version of this console broke it by setting everything in mono.
 * All-monospace reads as a developer's terminal rather than an instrument
 * someone runs a business on, and it wastes the one signal mono actually
 * carries: this is a figure, and its columns line up.
 *
 * Plex is IBM's design-system family — drawn for dense technical interfaces,
 * with a true tabular mono and a sans that holds up at 11px. It is also not
 * the default anyone reaches for.
 */
const sans = IBM_Plex_Sans({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  weight: ['400', '500'],
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Counterparty — selling mandate console',
  description: 'The merchant’s selling agent, with a signed selling mandate.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
