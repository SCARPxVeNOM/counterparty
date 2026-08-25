import type { Metadata } from 'next';
import { Instrument_Serif, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

/**
 * Instrument Serif for headings — high-contrast, slightly legal, and it carries
 * the weight the word "mandate" needs. IBM Plex Mono for everything else,
 * because every number on this screen is a readout and readouts are tabular.
 * Neither is a font anyone reaches for by default, which is the point.
 */
const display = Instrument_Serif({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-display',
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
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
