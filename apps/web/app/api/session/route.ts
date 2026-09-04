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
  counterfactual,
  formatRow,
  guardThreshold,
  paiseToRupees,
  pressureCeilingPct,
  publicKeyRef,
  verifyAsCounterparty,
  verifyChain,
  type AuditRow,
  type JsonObject,
} from '@counterparty/core';
import { Session } from '@counterparty/agents';
import { PERSONAS, type PersonaId } from '@counterparty/agents';
import { createProvider, type LLMProvider } from '@counterparty/llm';
import { MODELS, fromRepoRoot, loadConfig, readiness } from '@counterparty/config';
import { SqliteLedger } from '@counterparty/store';
import {
  CATALOG,
  CONSOLE_CASSETTE_DIR as CASSETTE_DIR,
  DEMO_MERCHANT,
  ScriptedSeller,
  demoBudget,
  demoMandate,
  gateKey,
  merchantKey,
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

/**
 * One ledger file for the whole console, opened once.
 *
 * Deliberately not one file per session. The chain is only worth something if it
 * spans everything written — a per-session file would let an entire session be
 * deleted without leaving a gap anywhere, which is precisely the edit a chain
 * exists to make visible. Sessions are a `session_id` column.
 *
 * The negotiation state itself stays in memory and a reload still starts a clean
 * negotiation, which is what anyone driving a demo console wants. What survives
 * is the record of what was decided, which is the thing that is supposed to
 * outlive the process that decided it.
 */
let ledgerHandle: SqliteLedger | undefined;

export function ledger(): SqliteLedger {
  ledgerHandle ??= new SqliteLedger({ path: fromRepoRoot('data', 'console.db') });
  return ledgerHandle;
}

export function sessionFor(id: string): Session {
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
    ledger: ledger(),
  });
  sessions.set(id, session);
  return session;
}

function view(session: Session, id: string) {
  const mandate = demoMandate();
  const pressure = session.pressure;

  function revenueView() {
    const result = counterfactual([...ledger().rows]);
    return {
      capPct: result.capPct,
      deals: result.lines.length,
      divergent: result.divergent,
      envelopeInr: result.envelopeRevenueInr,
      staticInr: result.staticRevenueInr,
      deltaInr: result.deltaInr,
      upliftPct: result.upliftPct,
      lines: result.lines.map((l) => ({
        buyerId: l.buyerId,
        listInr: l.listInr,
        ceilingPct: l.ceilingPct,
        envelopePct: l.envelopePct,
        staticPct: l.staticPct,
        deltaInr: l.deltaInr,
        clause: l.clause,
      })),
    };
  }

  /**
   * This session's rows for the panel; the whole file for the verdict.
   *
   * Those are two different questions and conflating them would weaken both.
   * The panel is showing one negotiation, so it shows one negotiation. The
   * chain, though, only means anything verified end to end — checking just this
   * session's slice would happily pass over a file with an earlier session
   * deleted, which is exactly the edit worth catching.
   */
  const rows: AuditRow[] = [...ledger().forSession(id)];
  const wholeFile = ledger().verify();

  /**
   * A session's rows cannot be chain-verified on their own, and trying to is a
   * bug that hides until the second session.
   *
   * `verifyChain` walks from the genesis hash forward. A slice starting at seq
   * 12 has a `prev_hash` pointing at row 11, which is not in the slice, so the
   * walk fails and the console reports CHAIN BROKEN over a ledger that is
   * perfectly intact. The first session on a fresh database starts at seq 1 and
   * passes, which is exactly why this survived until there was history on disk.
   *
   * The chain spans the file, so the file is what gets verified. There is only
   * one honest answer to "is this ledger intact" and it is not per-session.
   */
  const chain = wholeFile;
  const config = loadConfig();

  const ceiling = pressureCeilingPct(pressure.state, mandate.authority.max_discount_depth_pct);

  return {
    id,
    /**
     * Each agent reply carries the audit row its gate decision landed on.
     *
     * The console used to derive this by counting decision rows and assuming
     * the nth one belonged to the nth agent utterance. That assumption fails
     * three ways — an incident row written before a decision, a refusal that
     * retries and writes twice, and a ledger already holding rows from an
     * earlier session under the same id — and the last one put the wrong
     * clause under every reply after a reset.
     */
    transcript: session.transcript.map((entry, index) => {
      const turn = Math.floor(index / 2);
      if (entry.speaker === 'buyer') {
        // Marked on the buyer's own message, because that message is what
        // tightened the envelope.
        return { ...entry, tightened: session.incidentAtTurn.includes(turn + 1) };
      }
      return { ...entry, rowSeq: session.decisionRowSeqs[turn] ?? null };
    }),
    offers: session.signedOffers.map((offer) => {
      /**
       * The buyer's check, run on the buyer's inputs.
       *
       * Serialized first, deliberately. Handing the verifier the live in-process
       * object would check something no counterparty ever sees; a buyer receives
       * JSON over a wire, and any field that does not survive that trip is a
       * field the check must not depend on.
       */
      const wire = JSON.parse(JSON.stringify(offer)) as JsonObject;
      const verdict = verifyAsCounterparty({
        offer: wire,
        envelope: JSON.parse(JSON.stringify(mandate)) as JsonObject,
        merchantPublicKey: publicKeyRef(merchantKey),
      });

      return {
        offer_id: offer.offer_id,
        list_total_inr: offer.list_total_inr,
        offered_total_inr: offer.offered_total_inr,
        depth_pct: offer.depth_pct,
        authorized_by: offer.authorized_by,
        signature: offer.signature.sig,
        expires_at: offer.expires_at,
        counterparty: {
          accepted: verdict.ok,
          failed: verdict.ok ? null : verdict.failed,
          detail: verdict.ok ? null : verdict.detail,
          checks: verdict.checks.map((c) => ({ check: c.check, ok: c.ok, detail: c.detail })),
        },
      };
    }),
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
      /**
       * What is on disk, across every session this console has run.
       *
       * Surfaced because "the ledger persists" is a claim, and a number that
       * keeps climbing after a restart is the cheapest possible proof of it.
       */
      persisted: {
        rows: ledger().size,
        chainIntact: wholeFile.ok,
        detail: wholeFile.ok ? null : wholeFile.detail,
      },
    },
    /**
     * What the envelope was worth, over every session on disk.
     *
     * Computed across the whole ledger rather than this session, because a
     * single negotiation cannot show the point: the comparison only says
     * anything once a day contains both a buyer the envelope let through and one
     * it did not.
     */
    revenue: revenueView(),
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

  /**
   * A reset starts a new negotiation, so it gets a new session id.
   *
   * Reusing the id looked tidier and was wrong twice over. The ledger is
   * append-only — as it must be — so `forSession('console')` kept returning
   * every row this console had ever written, and after a reset the panel
   * showed eight rows for a conversation that had not started yet. It also put
   * the *previous* run's clause under the new run's first reply, because the
   * old row was still the one the count landed on.
   *
   * Nothing is deleted. The rows stay on disk and stay in the chain; only the
   * question the panel asks changes, from "everything ever done under this
   * name" to "this negotiation".
   */
  if (body.reset === true) {
    sessions.delete(id);
    const fresh = `console_${Date.now().toString(36)}`;
    return NextResponse.json(view(sessionFor(fresh), fresh));
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

