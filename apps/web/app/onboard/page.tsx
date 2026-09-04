'use client';

/**
 * The onboarding screen.
 *
 * §6's one screen: point it at a storefront, see what was read, see the
 * confidence, see the evidence, see what authority that earns. The merchant
 * confirms — or looks at the number, sees why it is low, and fixes the page.
 *
 * The design constraint that shaped this: every confidence score is rendered
 * next to the thing that produced it. A bar on its own is a verdict the
 * merchant has to accept. A bar next to "no unit cost anywhere in the page"
 * is an argument they can act on.
 */

import { useCallback, useEffect, useState } from 'react';
import { Shell } from '../shell';
import type { OnboardResponse } from '../api/onboard/route';

interface Fixture {
  readonly name: string;
  readonly url: string;
  readonly note: string;
}

export default function OnboardPage() {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [target, setTarget] = useState('razorpayPage');
  const [sku, setSku] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OnboardResponse | null>(null);

  useEffect(() => {
    void fetch('/api/onboard')
      .then((r) => r.json() as Promise<{ fixtures: Fixture[] }>)
      .then((d) => setFixtures(d.fixtures))
      .catch(() => setFixtures([]));
  }, []);

  const run = useCallback(
    async (value: string) => {
      setBusy(true);
      setResult(null);
      try {
        const response = await fetch('/api/onboard', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: value, sku }),
        });
        setResult((await response.json()) as OnboardResponse);
      } catch (error) {
        setResult({ ok: false, error: (error as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [sku],
  );

  return (
    <Shell page="onboard">
      <div className="topbar">
        <h1>Onboarding</h1>
        <span className="tagline">what the agent may sell, and on what authority</span>
      </div>

      <div className="onboard">

      <section className="panel">
        <div className="panel-head">Source</div>
        <div className="panel-body">
          <p className="lede">
            The selling agent cannot negotiate without knowing what it sells and at what margin.
            Point it at a page. Every field it reads arrives with the evidence behind it.
          </p>

          <div className="composer-line">
            <input
              className="target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="https://… or a fixture name"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void run(target);
              }}
            />
            <input
              className="sku"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="SKU (optional)"
            />
            <button className="primary" disabled={busy} onClick={() => void run(target)}>
              {busy ? 'reading…' : 'read it'}
            </button>
          </div>

          <div className="fixtures">
            {fixtures.map((f) => (
              <button
                key={f.name}
                className={`persona${target === f.name ? ' on' : ''}`}
                title={f.note}
                onClick={() => {
                  setTarget(f.name);
                  void run(f.name);
                }}
              >
                {f.name}
              </button>
            ))}
          </div>
        </div>
      </section>

      {result === null ? null : result.ok !== true ? (
        <section className="panel collapsed">
          <div className="panel-head">Extraction failed</div>
          <div className="panel-body">
            <p className="reason">{result.error}</p>
            {result.source === undefined ? null : (
              <p className="reason dim">
                {result.source.url} — {result.source.bytes} bytes, read as {result.source.kind}
              </p>
            )}
          </div>
        </section>
      ) : (
        <Result result={result} />
      )}
      </div>
    </Shell>
  );
}

function Result({ result }: { result: OnboardResponse }) {
  const entry = result.entry;
  const authority = result.authority;
  if (entry === undefined || authority === undefined || result.source === undefined) return null;

  const blocked = authority.clause !== null;

  return (
    <>
      <section className="panel">
        <div className="panel-head">What was read</div>
        <div className="panel-body">
          <div className="readout">
            <span className="readout-label">source</span>
            <span className="mono-wrap">{result.source.url}</span>
          </div>
          <div className="readout">
            <span className="readout-label">read as</span>
            <span>
              {result.source.kind === 'razorpay_payment_page'
                ? 'Razorpay Payment Page — structured JSON payload'
                : 'storefront markup'}
              {'  '}
              <span className="dim">({result.source.bytes.toLocaleString()} bytes)</span>
            </span>
          </div>
          <div className="readout">
            <span className="readout-label">sku</span>
            <span>{entry.sku}</span>
          </div>
          <div className="readout">
            <span className="readout-label">title</span>
            <span>{entry.title}</span>
          </div>
          <div className="readout">
            <span className="readout-label">list price</span>
            <span className="big">₹{entry.listPriceInr.toLocaleString('en-IN')}</span>
          </div>
          <div className="readout">
            <span className="readout-label">unit cost</span>
            <span className={entry.unitCostInr === 0 ? 'oxide' : ''}>
              {entry.unitCostInr === 0 ? 'not stated on the page' : `₹${entry.unitCostInr.toLocaleString('en-IN')}`}
            </span>
          </div>
          <div className="readout">
            <span className="readout-label">availability</span>
            <span>{entry.availability}</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">Confidence, and what moved it</div>
        <div className="panel-body">
          {(result.fields ?? []).map((field) => (
            <div key={field.field} className="field">
              <div className="field-head">
                <span className="readout-label">{field.field}</span>
                <span className={field.confidence < 0.85 ? 'oxide' : 'amber'}>
                  {field.confidence.toFixed(3)}
                </span>
              </div>
              <div className="meter">
                <div
                  className={`meter-fill ${field.confidence < 0.85 ? 'oxide' : 'amber'}`}
                  style={{ width: `${Math.max(1, field.confidence * 100)}%` }}
                />
                <div className="meter-tick" style={{ left: '85%' }} title="min_margin_confidence" />
              </div>
              {field.ambiguities.length === 0 ? (
                <p className="reason dim">nothing on the page contradicts this reading</p>
              ) : (
                field.ambiguities.map((a, i) => (
                  <p key={i} className="reason">
                    <span className="kind">{a.kind}</span> {a.note}
                    {a.evidence === '' ? null : (
                      <span className="evidence">{a.evidence.slice(0, 120)}</span>
                    )}
                  </p>
                ))
              )}
              {/*
                For an absent field the provenance snippet IS the evidence, so
                printing both says the same sentence twice. Show the snippet
                only when it adds something.
              */}
              <p className="reason dim provenance">
                {field.ambiguities.some((a) => a.evidence === field.snippet) ? null : (
                  <>
                    {field.snippet.slice(0, 160)}
                    <br />
                  </>
                )}
                seen {field.crawledAt}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className={`panel${blocked ? ' collapsed' : ''}`}>
        <div className="panel-head">Draft authority</div>
        <div className="panel-body">
          <div className="readout">
            <span className="readout-label">max depth</span>
            <span className={blocked ? 'big oxide' : 'big amber'}>
              {authority.maxDiscountDepthPct === 0 ? '0%' : authority.maxDiscountDepthPct}
            </span>
          </div>
          {authority.clause === null ? null : (
            <div className="readout">
              <span className="readout-label">clause</span>
              <span className="oxide">{authority.clause}</span>
            </div>
          )}
          <p className="reason">{authority.reason}</p>
          {blocked ? (
            <p className="reason dim">
              The SKU still sells — at list price, with a signed offer. Uncertainty removes the
              authority to discount, not the ability to trade.
            </p>
          ) : null}
        </div>
      </section>
    </>
  );
}
