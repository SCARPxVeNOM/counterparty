/**
 * The application shell: a fixed sidebar and a scrolling work area.
 *
 * THE NAVIGATION IS REAL.
 *
 * Dashboard templates ship a sidebar with eight plausible destinations, and
 * filling one out with items that go nowhere is worse than having no sidebar
 * at all — it is the first thing a reader clicks and the first promise the
 * product breaks. This one lists the two pages that exist, and gives the rest
 * of the rail to things that are true right now: which model is driving, what
 * the authorize step is doing, and whether the audit chain verifies.
 *
 * That last group is the reason a rail earns its space here. On a console that
 * adjudicates money, "what mode am I in" is not chrome — it is the first
 * question anyone should be able to answer without scrolling.
 */

import type { ReactNode } from 'react';

export interface ShellStatus {
  readonly agentMode: 'gemini' | 'scripted';
  readonly authorizeMode: 'live' | 'sim';
  readonly chainIntact: boolean;
  readonly rowsOnDisk: number;
}

function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d={path} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const GLYPH = {
  console: 'M3 5.5h14M3 10h14M3 14.5h9',
  onboard: 'M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5M3.5 14v2.5h13V14',
  agent: 'M10 2.5 3 6v5c0 3.6 2.9 6.2 7 6.9 4.1-.7 7-3.3 7-6.9V6l-7-3.5Z',
  rails: 'M2.5 10h15M6 6l-3.5 4L6 14M14 6l3.5 4L14 14',
  chain: 'M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 1 0-4.2-4.2l-.7.7M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8a3 3 0 1 0 4.2 4.2l.7-.7',
} as const;

export function Shell({
  page,
  status,
  children,
}: {
  page: 'console' | 'onboard';
  status?: ShellStatus;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="rail">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Counterparty</span>
        </a>

        <nav className="rail-nav" aria-label="Pages">
          <a className={`rail-link${page === 'console' ? ' on' : ''}`} href="/">
            <Icon path={GLYPH.console} />
            Negotiation console
          </a>
          <a className={`rail-link${page === 'onboard' ? ' on' : ''}`} href="/onboard">
            <Icon path={GLYPH.onboard} />
            Onboarding
          </a>
        </nav>

        {status !== undefined && (
          <>
            <div className="rail-label">Running as</div>
            <div className="rail-facts">
              <div className="fact">
                <Icon path={GLYPH.agent} />
                <span className="fact-name">Selling agent</span>
                <span className={`fact-value${status.agentMode === 'gemini' ? ' on' : ''}`}>
                  {status.agentMode === 'gemini' ? 'Gemini' : 'Scripted'}
                </span>
              </div>
              <div className="fact">
                <Icon path={GLYPH.rails} />
                <span className="fact-name">Card tap</span>
                <span className="fact-value">
                  {status.authorizeMode === 'live' ? 'Live' : 'Simulated'}
                </span>
              </div>
              <div className="fact">
                <Icon path={GLYPH.chain} />
                <span className="fact-name">Audit chain</span>
                <span className={`fact-value ${status.chainIntact ? 'proof' : 'bad'}`}>
                  {status.chainIntact ? 'Verified' : 'Broken'}
                </span>
              </div>
            </div>

            {/*
              Where a template puts an upgrade promo. This is the one number on
              the page that keeps climbing across restarts, which is the whole
              claim of a ledger that outlives the process that wrote it.
            */}
            <div className="rail-card">
              <div className="rail-card-value">{status.rowsOnDisk.toLocaleString('en-IN')}</div>
              <div className="rail-card-label">rows on disk</div>
              <p>
                Every decision ever made by this console, hash-chained. It survives a restart
                because a record that does not is not evidence.
              </p>
            </div>
          </>
        )}
      </aside>

      <main className="work">{children}</main>
    </div>
  );
}
