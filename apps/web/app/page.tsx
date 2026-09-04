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

interface CounterpartyCheck {
  check: string;
  ok: boolean;
  detail: string;
}

interface Offer {
  offer_id: string;
  list_total_inr: number;
  offered_total_inr: number;
  depth_pct: number;
  authorized_by: string;
  signature: string;
  expires_at: string;
  /** The buyer's own verdict, run on the serialized offer. */
  counterparty: {
    accepted: boolean;
    failed: string | null;
    detail: string | null;
    checks: CounterpartyCheck[];
  };
}

interface View {
  id: string;
  transcript: Array<{
    speaker: 'buyer' | 'agent';
    text: string;
    /** Agent turns: the ledger row this reply's gate decision landed on. */
    rowSeq?: number | null;
    /** Buyer turns: this message crossed a pressure threshold. */
    tightened?: boolean;
  }>;
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
  ledger: {
    rows: Row[];
    chainIntact: boolean;
    head: string | null;
    /** The whole file, across every session: rows this console has ever written. */
    persisted: { rows: number; chainIntact: boolean; detail: string | null };
  };
  revenue: {
    capPct: number;
    deals: number;
    divergent: number;
    envelopeInr: number;
    staticInr: number;
    deltaInr: number;
    upliftPct: number;
    lines: Array<{
      buyerId: string;
      listInr: number;
      ceilingPct: number;
      envelopePct: number;
      staticPct: number;
      deltaInr: number;
      clause: string;
    }>;
  };
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
  /**
   * The session this console is driving.
   *
   * Minted on mount rather than fixed at 'console'. The audit ledger is
   * append-only and shared across every run — as it has to be, or a whole
   * session could be deleted without leaving a gap — so a fixed id meant
   * `forSession` returned every row this console had ever written, and a freshly
   * loaded page opened showing eight rows for a conversation that had not
   * started. Nothing is hidden: the on-disk count beside it still reports the
   * whole file.
   *
   * Empty until the mount effect runs, so the server is never asked about a
   * session id that came from a render the server also produced.
   */
  const [sessionId, setSessionId] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * The message in flight, shown immediately.
   *
   * A scripted persona replays from a cassette in about 100ms, but a
   * free-typed message is a live model call and takes tens of seconds. Until
   * this existed the composer cleared on send and the transcript showed
   * nothing at all for that whole time — the reader's own words vanished and
   * the console looked frozen.
   */
  const [pending, setPending] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const ledgerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (sessionId === '') return;
    const response = await fetch(`/api/session?id=${encodeURIComponent(sessionId)}`, {
      cache: 'no-store',
    });
    setView((await response.json()) as View);
  }, [sessionId]);

  useEffect(() => {
    setSessionId((current) =>
      current === '' ? `console_${Date.now().toString(36)}` : current,
    );
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
      setPending(message);
      try {
        const response = await fetch('/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sessionId, message }),
        });
        setView((await response.json()) as View);
      } finally {
        setBusy(false);
        setPending(null);
      }
    },
    [busy, sessionId],
  );

  const reset = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId, reset: true }),
      });
      const next = (await response.json()) as View;
      setSessionId(next.id);
      setView(next);
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

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
      <section className="panel negotiation">
        <div className="panel-head">
          negotiation
          <span className="count">{Math.ceil(view.transcript.length / 2)} turns</span>
        </div>

        <div className="panel-body" ref={transcriptRef}>
          {view.transcript.length === 0 ? (
            <div className="intro">
              {/*
                The first screen has to answer "what am I looking at" before it
                answers anything else. Someone who has never seen this project
                should be able to read this, press one button, and understand
                what happened — without knowing what a mandate is.
              */}
              <h1>An AI sales agent that cannot give away your money</h1>
              <p className="intro-lede">
                Shops are starting to let AI answer customers and quote prices. The risk is
                obvious: a car dealership&rsquo;s chatbot was talked into selling a $76,000 truck for
                $1. The AI here can say anything too — but it <b>cannot agree to a price on its
                own</b>.
              </p>

              <ol className="how">
                <li>
                  <span className="step">1</span>
                  <div>
                    <b>The shop owner signs a rulebook.</b> Maximum 15% off, never below cost,
                    ₹40,000 of discounts a day. It is signed, so it cannot be edited afterwards
                    without that being obvious.
                  </div>
                </li>
                <li>
                  <span className="step">2</span>
                  <div>
                    <b>The AI negotiates, but only proposes.</b> Every price it wants to offer is
                    handed to a separate checker that holds the rulebook.
                  </div>
                </li>
                <li>
                  <span className="step">3</span>
                  <div>
                    <b>The checker approves or refuses, and says which rule applied.</b> Approved
                    prices get a cryptographic signature. Nothing without one can take payment.
                  </div>
                </li>
              </ol>

              <div className="try">
                <div className="try-head">Try it — pick a buyer below</div>
                <p>
                  <b>Honest bulk buyer</b> negotiates fairly and gets a real discount. Watch the
                  middle panel approve it.
                </p>
                <p>
                  <b>Prompt injector</b> <span className="marker">•</span> hides an instruction in
                  their message telling the AI to give 90% off. Watch the discount limit drop to
                  zero and stay there — the sale still completes, at full price.
                </p>
                <p className="try-foot">
                  Or type your own message and try to talk it into a price it is not allowed to
                  give. Everything either agent does lands in the audit log on the right.
                </p>
              </div>
            </div>
          ) : (
            <div className="transcript">
              {view.transcript.map((entry, index) => {
                const buyerTurn = Math.floor(index / 2) + 1;
                const verdict =
                  entry.rowSeq == null
                    ? undefined
                    : view.ledger.rows.find((r) => r.seq === entry.rowSeq);
                return (
                  <div className={`utterance ${entry.speaker}`} key={index}>
                    <div className="who">{entry.speaker === 'buyer' ? 'buyer' : 'agent'}</div>
                    <div className="said">
                      {entry.speaker === 'buyer'
                        ? markEvidence(entry.text, evidenceByTurn.get(buyerTurn) ?? [])
                        : entry.text}
                    </div>
                    {entry.speaker === 'buyer' && entry.tightened === true && (
                      <div className="tightened">
                        <b>Envelope tightened.</b> Deterministic detectors flagged this message
                        before the model saw it. Discount authority is now{' '}
                        {view.authority.ceilingPct}%.
                      </div>
                    )}
                    {verdict !== undefined && <Verdict row={verdict} />}
                    {/*
                      An agent turn with no decision row is an ordinary outcome —
                      the agent answered a question without proposing a price —
                      but with nothing rendered it looks like the console failed.
                      Silence about a non-event is still silence.
                    */}
                    {entry.speaker === 'agent' && entry.rowSeq == null && (
                      <div className="no-decision">
                        No price proposed, so the gate had nothing to rule on.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* The turn in flight, so the reader's own message never disappears. */}
          {pending !== null && (
            <div className="transcript pending">
              <div className="utterance buyer">
                <div className="who">buyer</div>
                <div className="said">{pending}</div>
              </div>
              <div className="utterance agent">
                <div className="who">agent</div>
                <div className="working">
                  <span className="spin" />
                  <span>
                    Detectors have run. Waiting on the model, then the gate.
                    <span className="working-note">
                      A scripted buyer replays instantly; a message you typed is a live
                      model call and can take up to a minute.
                    </span>
                  </span>
                </div>
              </div>
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
          {/* ── the three numbers you glance at ──────────────────────────
              One band, side by side. As three stacked blocks with a 46px
              figure each, they pushed everything else below the fold and
              gave a budget gauge the same weight as the collapse state. */}
          <section className="group">
            <div className="group-head">Live authority</div>
            <div className="stat-band">
            <div className="stat">
              <div className="stat-label">Discount authority</div>
              <div className={`stat-value ${collapsed ? 'oxide' : 'amber'}`}>
                {view.authority.ceilingPct.toFixed(1)}
                <span className="unit">%</span>
              </div>
              <div className={`stat-sub ${collapsed ? 'oxide' : ''}`}>
                {collapsed ? 'revoked · was ' : 'ceiling '}
                {view.authority.mandateCeilingPct}%
              </div>
            </div>

            <div className="stat">
              <div className="stat-label">Manipulation pressure</div>
              <div className={`stat-value ${collapsed ? 'oxide' : ''}`}>
                {view.pressure.score.toFixed(2)}
              </div>
              <div className="stat-sub">
                guard {view.pressure.guardThreshold} · collapse {view.pressure.collapseThreshold}
              </div>
              <div className="stat-rule">
                <i
                  className={collapsed ? 'oxide' : ''}
                  style={{ width: `${Math.min(100, view.pressure.score * 100)}%` }}
                />
              </div>
            </div>

            <div className="stat">
              <div className="stat-label">Discount budget</div>
              <div className="stat-value">{money(view.budget.remainingInr)}</div>
              <div className="stat-sub">of {money(view.budget.limitInr)} today</div>
              <div className="stat-rule">
                <i style={{ width: `${Math.max(0, budgetPct)}%` }} />
              </div>
            </div>
          </div>

            <div className="ratchet-row">
            <span className="stat-label">Envelope state</span>
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
          </section>

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

          {/* ── the buyer's own check ──────────────────────────────────
              Everything above this line is the merchant checking the
              merchant. This is the other side of the table: the offer
              serialized to JSON, the envelope, the merchant's public key,
              and nothing else. Same function the CLI runs. */}
          {lastOffer !== undefined && (
            <div className="clauses counterparty">
              <div className="readout-label">
                counterparty check
                <span className={`aside ${lastOffer.counterparty.accepted ? 'ok' : 'alarm'}`}>
                  {lastOffer.counterparty.accepted ? 'ACCEPTED' : 'REJECTED'}
                </span>
              </div>
              {lastOffer.counterparty.checks.map((c) => (
                <Clause
                  key={c.check}
                  name={c.check.replace(/_/g, ' ')}
                  value={c.ok ? 'ok' : 'FAILED'}
                  void={!c.ok}
                  title={c.detail}
                />
              ))}
              {lastOffer.counterparty.detail !== null && (
                <div className="aside alarm">{lastOffer.counterparty.detail}</div>
              )}
            </div>
          )}

          {/* ── what the envelope earned ────────────────────────────────
              The other half of the track's ask. Computed from the ledger
              on disk, across every session, against a flat cap. */}
          {view.revenue.deals > 0 && (
            <div className="clauses">
              <div className="readout-label">
                against a flat {view.revenue.capPct}% cap
                <span className="aside">{view.revenue.deals} deals on disk</span>
              </div>
              <Clause name="a flat cap earns" value={money(view.revenue.staticInr)} />
              <Clause name="this envelope earned" value={money(view.revenue.envelopeInr)} binding />
              <Clause
                name="difference"
                value={`${view.revenue.deltaInr >= 0 ? '+' : ''}${money(view.revenue.deltaInr)} · ${view.revenue.upliftPct}%`}
                binding={view.revenue.deltaInr > 0}
                title={`${view.revenue.divergent} of ${view.revenue.deals} deals priced differently; the rest were identical under both policies`}
              />
            </div>
          )}

          {/* ── reference ───────────────────────────────────────────────
              Demoted deliberately. These do not change during a
              negotiation, and a column where nine blocks shout equally is
              a column with no hierarchy at all. The live readouts are
              above; this is what a reader consults, not what they watch. */}
          <div className="reference">
            <div className="reference-head">reference · does not change during a session</div>
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

          </div>
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
          {/* The count on disk keeps climbing across restarts; this session's
              does not. Seeing both at once is what makes "it persists" a
              observation rather than a claim in a README. */}
          <span
            className={`count persisted ${view.ledger.persisted.chainIntact ? '' : 'alarm'}`}
            title={
              view.ledger.persisted.detail ??
              'every row this console has ever written, in data/console.db, chain verified from the file'
            }
          >
            {view.ledger.persisted.rows} on disk
            {view.ledger.persisted.chainIntact ? '' : ' — CHAIN BROKEN'}
          </span>
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
  title,
}: {
  name: string;
  value: string;
  binding?: boolean;
  void?: boolean;
  /** Hover text. Defaults to the clause name; a check passes its own reasoning. */
  title?: string;
}) {
  return (
    <div
      className={`clause-row${binding === true ? ' binding' : ''}${voided === true ? ' void' : ''}`}
      title={title ?? name}
    >
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

