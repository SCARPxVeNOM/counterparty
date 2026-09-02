/**
 * The console's server side.
 *
 * Holds sessions in memory, keyed by id. That is the right amount of
 * persistence for a demo console: a reload starts a clean negotiation, which is
 * what anyone driving it actually wants, and nothing here is the system of
 * record — the audit ledger is.
 *
 * The important property is that this route does nothing clever. It calls the
 * same `Session` the scenario runner and the tests call. There is no console
 * path through the gate that the headless path does not also take.
 */

import { NextResponse } from 'next/server';
import {
  formatRow,
  guardThreshold,
  paiseToRupees,
  pressureCeilingPct,
  verifyChain,
  type AuditRow,
} from '@counterparty/core';
import { Session } from '@counterparty/agents';
import { PERSONAS, type PersonaId } from '@counterparty/agents';
import { createProvider, type LLMProvider } from '@counterparty/llm';
import { MODELS, loadConfig, readiness } from '@counterparty/config';
import {
  CATALOG,
  CONSOLE_CASSETTE_DIR as CASSETTE_DIR,
  DEMO_MERCHANT,
  ScriptedSeller,
  demoBudget,
  demoMandate,
  gateKey,
} from '@counterparty/demo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sessions = new Map<string, Session>();

/**
 * Gemini when a key is configured, a rule-based stand-in otherwise.
 *
 * The console has to work the moment someone clones this. With no key and no
 * recording, every turn would otherwise fail on a cassette miss — which teaches
 * nobody anything about a system whose entire claim is that the model is not
 * what makes an offer binding.
 *
 * The stand-in writes the agent's prose and picks what to propose. It changes
 * nothing else: the detectors, the reducer, the ratchet, every clause check,
 * the signing, the budget and the audit chain all run exactly as they do live,
 * because none of them are downstream of the model. The response badges which
 * one is driving so this is never something anyone has to take on trust.
 */
function providerFor(): { provider: LLMProvider; agentMode: 'gemini' | 'scripted' } {
  const config = loadConfig();
  if (config.geminiApiKey === '') {
    return { provider: new ScriptedSeller(), agentMode: 'scripted' };
  }
  return { provider: createProvider({ cassetteDir: CASSETTE_DIR }).provider, agentMode: 'gemini' };
}

function sessionFor(id: string): Session {
  const existing = sessions.get(id);
  if (existing !== undefined) return existing;

  const { provider } = providerFor();
  const session = new Session({
    sessionId: id,
    buyerId: `buyer_${id}`,
    mandate: demoMandate(),
    gateKey,
    catalog: CATALOG,
    budget: demoBudget(),
    provider,
    sellingModel: MODELS.sellingAgent,
    classifierModel: MODELS.pressureClassifier,
    merchantName: DEMO_MERCHANT,
  });
  sessions.set(id, session);
  return session;
}

function view(session: Session, id: string) {
  const mandate = demoMandate();
  const pressure = session.pressure;
  const rows: AuditRow[] = [...session.ledger.rows];
  const chain = verifyChain(rows);
  const config = loadConfig();

  const ceiling = pressureCeilingPct(pressure.state, mandate.authority.max_discount_depth_pct);

  return {
    id,
    transcript: session.transcript,
    offers: session.signedOffers.map((offer) => ({
      offer_id: offer.offer_id,
      list_total_inr: offer.list_total_inr,
      offered_total_inr: offer.offered_total_inr,
      depth_pct: offer.depth_pct,
      authorized_by: offer.authorized_by,
      signature: offer.signature.sig,
      expires_at: offer.expires_at,
    })),
    pressure: {
      state: pressure.state,
      score: pressure.score,
      turnScore: pressure.turnScore,
      signals: pressure.signals.map((s) => ({
        kind: s.kind,
        source: s.source,
        evidence: s.evidence,
        turn: s.turn,
        detail: s.detail ?? '',
      })),
      guardThreshold: guardThreshold(mandate.pressure_policy),
      collapseThreshold: mandate.pressure_policy.collapse_threshold,
    },
    authority: {
      ceilingPct: ceiling,
      mandateCeilingPct: mandate.authority.max_discount_depth_pct,
      bundleCeilingPct: mandate.authority.bundle_rules.combined_depth_pct,
      floorMarginPct: mandate.authority.floor_margin_pct,
      perBuyerCapInr: mandate.authority.per_buyer_discount_cap_inr,
      captureWindowHours: mandate.authority.capture_window_hours,
      minMarginConfidence: mandate.confidence_policy.min_margin_confidence,
    },
    budget: {
      remainingInr: session.remainingBudgetInr(),
      limitInr: mandate.authority.discount_budget_inr_per_day,
    },
    envelope: {
      id: mandate.envelope_id,
      merchantId: mandate.merchant_id,
      gateKid: mandate.gate_key.kid,
      merchantKid: mandate.signature.kid,
      expiresAt: mandate.expires_at,
    },
    ledger: {
      rows: rows.map((row) => ({
        seq: row.seq,
        at: row.at,
        action: row.action,
        outcome: row.outcome,
        authorized_by: row.authorized_by,
        clause_value: row.clause_value ?? null,
        amount_inr: row.amount_inr ?? null,
        depth_pct: row.depth_pct ?? null,
        hash: row.hash,
        rendered: formatRow(row),
      })),
      chainIntact: chain.ok,
      head: rows.at(-1)?.hash ?? null,
    },
    catalog: [...CATALOG.values()].map((sku) => ({
      sku: sku.sku,
      listInr: paiseToRupees(sku.listPrice),
      marginConfidence: sku.marginConfidence,
      lowConfidence: sku.marginConfidence < mandate.confidence_policy.min_margin_confidence,
    })),
    personas: Object.values(PERSONAS).map((p) => ({
      id: p.id,
      label: p.label,
      summary: p.summary,
      adversarial: p.adversarial,
      opening: p.scriptedOpening,
    })),
    runtime: {
      authorizeMode: config.authorizeMode,
      agentMode: providerFor().agentMode,
      readiness: readiness(config),
    },
  };
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id') ?? 'console';
  return NextResponse.json(view(sessionFor(id), id));
}

export async function POST(request: Request) {
  const body = (await request.json()) as { id?: string; message?: string; reset?: boolean };
  const id = body.id ?? 'console';

  if (body.reset === true) {
    sessions.delete(id);
    return NextResponse.json(view(sessionFor(id), id));
  }

  const message = (body.message ?? '').trim();
  if (message === '') {
    return NextResponse.json({ error: 'empty message' }, { status: 400 });
  }

  const session = sessionFor(id);

  try {
    await session.takeTurn(message);
  } catch (error) {
    /**
     * Surfaced rather than swallowed. The most likely cause by far is a
     * cassette miss with no Gemini key configured, and a console that silently
     * showed nothing would send whoever is driving it hunting through logs for
     * a problem the message names outright.
     */
    return NextResponse.json(
      { ...view(session, id), error: (error as Error).message },
      { status: 200 },
    );
  }

  return NextResponse.json(view(session, id));
}

export type ConsoleView = ReturnType<typeof view>;
export type { PersonaId };

