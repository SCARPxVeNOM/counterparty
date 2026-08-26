'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ── shapes returned by /api/session ──────────────────────────────────── */

type PressureState = 'NORMAL' | 'GUARDED' | 'COLLAPSED';

interface Signal {
  kind: string;
  source: 'detector' | 'model';
  evidence: string;
  turn: number;
  detail: string;
}

interface Row {
  seq: number;
  at: string;
  action: string;
  outcome: string;
  authorized_by: string;
  clause_value: string | number | null;
  amount_inr: number | null;
  depth_pct: number | null;
  hash: string;
  rendered: string;
}

interface Offer {
  offer_id: string;
  list_total_inr: number;
  offered_total_inr: number;
  depth_pct: number;
  authorized_by: string;
  signature: string;
  expires_at: string;
}

interface View {
  id: string;
  transcript: Array<{ speaker: 'buyer' | 'agent'; text: string }>;
  offers: Offer[];
  pressure: {
    state: PressureState;
    score: number;
    turnScore: number;
    signals: Signal[];
    guardThreshold: number;
    collapseThreshold: number;
  };
  authority: {
    ceilingPct: number;
    mandateCeilingPct: number;
    bundleCeilingPct: number;
    floorMarginPct: number;
    perBuyerCapInr: number;
    captureWindowHours: number;
    minMarginConfidence: number;
  };
  budget: { remainingInr: number; limitInr: number };
  envelope: {
    id: string;
    merchantId: string;
    gateKid: string;
    merchantKid: string;
    expiresAt: string;
  };
  ledger: { rows: Row[]; chainIntact: boolean; head: string | null };
  catalog: Array<{ sku: string; listInr: number; marginConfidence: number; lowConfidence: boolean }>;
  personas: Array<{ id: string; label: string; summary: string; adversarial: boolean; opening: string }>;
  runtime: {
    authorizeMode: 'live' | 'sim';
    agentMode: 'gemini' | 'scripted';
    readiness: { razorpay: string; gemini: string };
  };
  error?: string;
}

/* ── formatting ───────────────────────────────────────────────────────── */

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

function money(rupees: number): string {
  return `₹${inr.format(rupees)}`;
}

function shortHash(hash: string): string {
  return hash.slice(0, 10);
}

/* ── evidence marking ─────────────────────────────────────────────────── */

/**
 * Highlight the spans the detectors flagged, in place, inside the buyer's own
 * message. Nothing is paraphrased — the evidence strings are byte-for-byte what
 * the detectors captured, so a judge can see exactly what tripped the envelope
 * rather than being told about it.
 */
function markEvidence(text: string, spans: string[]): React.ReactNode {
  const usable = spans.filter((s) => s.length > 3 && text.includes(s)).sort((a, b) => b.length - a.length);
  if (usable.length === 0) return text;

  const parts: React.ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    let earliest = -1;
    let matched = '';
    for (const span of usable) {
      const at = rest.indexOf(span);
      if (at !== -1 && (earliest === -1 || at < earliest)) {
        earliest = at;
        matched = span;
      }
    }
    if (earliest === -1) {
      parts.push(rest);
      break;
    }
    if (earliest > 0) parts.push(rest.slice(0, earliest));
    parts.push(
      <mark className="evidence" key={key++} title="flagged by a deterministic detector">
        {matched}
      </mark>,
    );
    rest = rest.slice(earliest + matched.length);
  }
  return parts;
}

/* ── page ─────────────────────────────────────────────────────────────── */

export default function Console() {
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const ledgerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/session?id=console', { cache: 'no-store' });
    setView((await response.json()) as View);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
    ledgerRef.current?.scrollTo({ top: ledgerRef.current.scrollHeight, behavior: 'smooth' });
  }, [view?.transcript.length, view?.ledger.rows.length]);

  const send = useCallback(
    async (message: string) => {
      if (message.trim() === '' || busy) return;
      setBusy(true);
      setDraft('');
      try {
        const response = await fetch('/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'console', message }),
        });
        setView((await response.json()) as View);
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const reset = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'console', reset: true }),
      });
      setView((await response.json()) as View);
    } finally {
      setBusy(false);
    }
  }, []);

  /** Detector evidence, per buyer turn, so it can be marked in place. */
  const evidenceByTurn = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const signal of view?.pressure.signals ?? []) {
      if (signal.source !== 'detector') continue;
      map.set(signal.turn, [...(map.get(signal.turn) ?? []), signal.evidence]);
    }
    return map;
  }, [view?.pressure.signals]);

  if (view === null) {
    return (
      <div className="console">
        <div className="masthead">
          <span className="wordmark">Counterparty</span>
        </div>
        <div className="empty">Bringing the gate up…</div>
      </div>
    );
  }

  const collapsed = view.pressure.state === 'COLLAPSED';
  const budgetPct = (view.budget.remainingInr / view.budget.limitInr) * 100;
  const lastOffer = view.offers.at(-1);

  return (
    <div className={`console${collapsed ? ' collapsed' : ''}`}>
      <header className="masthead">
        <span className="wordmark">Counterparty</span>
        <span className="tagline">selling mandate · {view.envelope.merchantId}</span>
        <div className="masthead-right">
          <a
            className="badge"
            href="/onboard"
            title="Read a storefront or a Razorpay Payment Page, and see what discount authority it earns."
          >
            onboarding →
          </a>
          <span
            className={`badge ${view.runtime.agentMode === 'gemini' ? 'live' : 'sim'}`}
            title={
              view.runtime.agentMode === 'gemini'
                ? 'The selling agent is a live Gemini model.'
                : 'No GEMINI_API_KEY, so the agent’s prose is rule-based. The gate, the pressure detectors, the signing and the audit chain are unaffected — none of them are downstream of the model.'
            }
          >
            agent: {view.runtime.agentMode}
          </span>
          <span
            className={`badge ${view.runtime.authorizeMode === 'live' ? 'live' : 'sim'}`}
            title="Swaps only the moment a human taps a card. Orders, links, Offers, captures and refunds hit the real Razorpay API in both modes."
          >
            authorize: {view.runtime.authorizeMode}
          </span>
          <span className={`badge ${view.ledger.chainIntact ? 'proof' : 'alarm'}`}>
            <span className="dot" /> chain {view.ledger.chainIntact ? 'intact' : 'broken'}
          </span>
          {collapsed && (
            <span className="badge alarm">
              <span className="dot pulse" /> envelope collapsed
            </span>
          )}
          <button className="persona" onClick={reset} disabled={busy}>
            reset
          </button>
        </div>
      </header>

      {/* ── transcript ──────────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-head">
          negotiation
          <span className="count">{view.transcript.length} turns</span>
        </div>

        <div className="panel-body" ref={transcriptRef}>
          {view.transcript.length === 0 ? (
            <div className="empty">
              <p>
                This is the merchant&rsquo;s selling agent. It proposes; it never commits. Every price it
                puts forward goes to a <b>mandate gate</b> holding an envelope the merchant signed, and
                the gate either signs the offer or refuses it citing a clause by name.
              </p>
              <p>
                Negotiate with it below, or pick an adversarial persona and try to make it give away
                something the merchant never authorized.
              </p>
            </div>
          ) : (
            <div className="transcript">
              {view.transcript.map((entry, index) => {
                const buyerTurn = Math.floor(index / 2) + 1;
                const verdict = entry.speaker === 'agent' ? view.ledger.rows.find((r) => r.seq === rowSeqFor(view, index)) : undefined;
                return (
                  <div className={`utterance ${entry.speaker}`} key={index}>
                    <div className="who">{entry.speaker === 'buyer' ? 'buyer' : 'agent'}</div>
                    <div className="said">
                      {entry.speaker === 'buyer'
                        ? markEvidence(entry.text, evidenceByTurn.get(buyerTurn) ?? [])
                        : entry.text}
                    </div>
                    {verdict !== undefined && <Verdict row={verdict} />}
                  </div>
                );
              })}
            </div>
          )}
          {view.error !== undefined && (
            <div className="empty">
              <span className="badge alarm">error</span> {view.error}
            </div>
          )}
        </div>

        <div className="composer">
          <div className="personas">
            {view.personas.map((persona) => (
              <button
                key={persona.id}
                className={`persona${persona.adversarial ? ' hostile' : ''}`}
                title={persona.summary}
                disabled={busy}
                onClick={() => void send(persona.opening)}
              >
                {persona.label}
              </button>
            ))}
          </div>
          <div className="composer-line">
            <textarea
              value={draft}
              placeholder="Type as the buyer. Try to get a price the merchant never authorized."
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send(draft);
              }}
              disabled={busy}
            />
            <button className="send" onClick={() => void send(draft)} disabled={busy || draft.trim() === ''}>
              {busy ? 'gate…' : 'send'}
            </button>
          </div>
        </div>
      </section>

      {/* ── instruments ─────────────────────────────────────────────── */}
      <aside className="panel instruments">
        <div className="panel-head">mandate gate</div>
        <div className="panel-body">
          <div className="readout">
            <div className="readout-label">
              discount authority
              <span className="aside">
                {collapsed ? 'revoked' : `ceiling ${view.authority.mandateCeilingPct}%`}
              </span>
            </div>
            <div className={`big ${collapsed ? 'oxide' : 'amber'}`}>
              {view.authority.ceilingPct.toFixed(1)}
              <span className="unit">% off list</span>
            </div>
          </div>

          <div className="readout">
            <div className="readout-label">
              manipulation pressure
              <span className="aside">{view.pressure.score.toFixed(2)}</span>
            </div>
            <div className="meter">
              <div
                className={`meter-fill ${collapsed ? 'oxide' : 'amber'}`}
                style={{ width: `${Math.min(100, view.pressure.score * 100)}%` }}
              />
              <div className="meter-tick" style={{ left: `${view.pressure.guardThreshold * 100}%` }} />
              <div className="meter-tick" style={{ left: `${view.pressure.collapseThreshold * 100}%` }} />
            </div>
            <div className="meter-scale">
              <span>0</span>
              <span>guard {view.pressure.guardThreshold}</span>
              <span>collapse {view.pressure.collapseThreshold}</span>
            </div>

            <div className="ratchet" title="Monotonic within a session. Only human review resets it.">
              {(['NORMAL', 'GUARDED', 'COLLAPSED'] as const).map((state) => {
                const order = { NORMAL: 0, GUARDED: 1, COLLAPSED: 2 };
                const current = order[state] === order[view.pressure.state];
                const passed = order[state] < order[view.pressure.state];
                return (
                  <div
                    key={state}
                    className={`detent${current ? ' current' : ''}${passed ? ' passed' : ''}${
                      current && state === 'COLLAPSED' ? ' locked' : ''
                    }`}
                  >
                    {state}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="readout">
            <div className="readout-label">
              shared discount budget
              <span className="aside">today</span>
            </div>
            <div className="big amber">
              {money(view.budget.remainingInr)}
              <span className="unit">of {money(view.budget.limitInr)}</span>
            </div>
            <div className="meter" style={{ marginTop: 9 }}>
              <div className="meter-fill amber" style={{ width: `${Math.max(0, budgetPct)}%` }} />
            </div>
          </div>

          <div className="clauses">
            <div className="readout-label">envelope {view.envelope.id}</div>
            <Clause name="authority.max_discount_depth_pct" value={`${view.authority.mandateCeilingPct}%`} void={collapsed} />
            <Clause name="authority.bundle_rules.combined_depth_pct" value={`${view.authority.bundleCeilingPct}%`} void={collapsed} />
            <Clause name="authority.floor_margin_pct" value={`${view.authority.floorMarginPct}%`} />
            <Clause name="authority.per_buyer_discount_cap_inr" value={money(view.authority.perBuyerCapInr)} />
            <Clause name="authority.discount_budget_inr_per_day" value={money(view.budget.limitInr)} />
            <Clause name="authority.capture_window_hours" value={`${view.authority.captureWindowHours}h`} />
            <Clause name="confidence_policy.min_margin_confidence" value={String(view.authority.minMarginConfidence)} />
            <Clause
              name="pressure_policy.collapse_threshold"
              value={String(view.pressure.collapseThreshold)}
              binding={collapsed}
            />
          </div>

          <div className="clauses">
            <div className="readout-label">keys</div>
            <Clause name="merchant (issued the envelope)" value={view.envelope.merchantKid} />
            <Clause name="gate (signs offers)" value={view.envelope.gateKid} />
          </div>

          <div className="clauses">
            <div className="readout-label">
              catalog
              <span className="aside">margin confidence</span>
            </div>
            {view.catalog.map((sku) => (
              <Clause
                key={sku.sku}
                name={sku.sku}
                value={`${money(sku.listInr)} · ${sku.marginConfidence.toFixed(2)}`}
                void={sku.lowConfidence}
              />
            ))}
          </div>

          {lastOffer !== undefined && (
            <div className="clauses">
              <div className="readout-label">
                last signed offer
                <span className="aside">{lastOffer.offer_id}</span>
              </div>
              <Clause name="list" value={money(lastOffer.list_total_inr)} />
              <Clause name="offered" value={money(lastOffer.offered_total_inr)} binding />
              <Clause name="depth" value={`${lastOffer.depth_pct}%`} />
              <Clause name="gate signature" value={`${lastOffer.signature.slice(0, 18)}…`} />
            </div>
          )}
        </div>
      </aside>

      {/* ── ledger ──────────────────────────────────────────────────── */}
      <section className="ledger">
        <div className="panel-head">
          audit ledger
          <span className="chain-state">
            <span className="dot" />
            {view.ledger.head === null ? 'empty' : `head ${shortHash(view.ledger.head)}`}
          </span>
          <span className="count">{view.ledger.rows.length} rows</span>
        </div>
        <div className="ledger-body" ref={ledgerRef}>
          {view.ledger.rows.length === 0 ? (
            <div className="empty">
              Every money action, every refusal and every pressure incident lands here, each row
              hash-chained to the one before it.
            </div>
          ) : (
            view.ledger.rows.map((row) => (
              <div
                className={`row${row.outcome === 'refused' ? ' refused' : ''}${
                  row.action === 'pressure_incident' ? ' incident' : ''
                }`}
                key={row.seq}
                title={row.rendered}
              >
                <span className="seq">#{String(row.seq).padStart(3, '0')}</span>
                <span className="action">{row.action}</span>
                <span className="cite">
                  clause:{row.authorized_by}
                  {row.clause_value !== null ? ` (${row.clause_value})` : ''}
                </span>
                <span className="amount">
                  {row.amount_inr === null
                    ? '—'
                    : `${money(row.amount_inr)}${row.depth_pct === null ? '' : ` · ${row.depth_pct}%`}`}
                </span>
                <span className="hash">{shortHash(row.hash)}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

/* ── small pieces ─────────────────────────────────────────────────────── */

function Clause({
  name,
  value,
  binding,
  void: voided,
}: {
  name: string;
  value: string;
  binding?: boolean;
  void?: boolean;
}) {
  return (
    <div className={`clause-row${binding === true ? ' binding' : ''}${voided === true ? ' void' : ''}`} title={name}>
      <span className="name">{name}</span>
      <span className="value">{value}</span>
    </div>
  );
}

function Verdict({ row }: { row: Row }) {
  const refused = row.outcome === 'refused';
  return (
    <div className={`verdict ${refused ? 'refused' : 'signed'}`}>
      <div className="verdict-head">
        <span>{refused ? 'gate refused' : 'gate signed'}</span>
        {row.amount_inr !== null && <span className="verdict-amount">{money(row.amount_inr)}</span>}
      </div>
      <div className="clause">
        clause: <b>{row.authorized_by}</b>
        {row.clause_value !== null ? ` (${row.clause_value})` : ''}
      </div>
    </div>
  );
}

/**
 * Map an agent utterance back to the ledger row it produced.
 *
 * Turns are appended in pairs, and each turn writes at most one signed or
 * refused row (plus, possibly, an incident row before it). Walking the rows in
 * order and skipping incidents lines them up with agent utterances.
 */
function rowSeqFor(view: View, transcriptIndex: number): number | undefined {
  if (transcriptIndex % 2 === 0) return undefined;
  const turn = Math.floor(transcriptIndex / 2);
  const decisions = view.ledger.rows.filter((r) => r.action !== 'pressure_incident');
  return decisions[turn]?.seq;
}
