/**
 * The negotiation session — where every piece meets.
 *
 * One turn, in order:
 *
 *   1. deterministic detectors run on the RAW buyer message
 *   2. the model classifier runs on the same message
 *   3. the reducer unions both and decides the pressure state
 *   4. the selling agent proposes, knowing the ceiling but unable to exceed it
 *   5. the gate signs or refuses, citing a clause
 *   6. the audit ledger records what happened, including refusals
 *
 * Step 1 before step 2 is not incidental. By the time a message could have
 * captured the model, the detectors have already observed it, and their signals
 * are already in the union.
 *
 * The session holds no money-moving code. It decides and records; the rails
 * execute, and only against something the gate signed.
 */

import {
  MemoryLedger,
  evaluateQuote,
  guardThreshold,
  pressureCeilingPct,
  paiseToRupees,
  reducePressure,
  runDetectors,
  available,
  poolPosition,
  INITIAL_PRESSURE,
  type AuditEntry,
  type AuditRow,
  type BudgetState,
  type GateContext,
  type KeyPair,
  type LedgerWriter,
  type PressureSignal,
  type PressureSnapshot,
  type Refusal,
  type SellingMandate,
  type SignedOffer,
  type SkuPricing,
  type TurnRecord,
} from '@counterparty/core';
import { classifyPressure, type LLMProvider } from '@counterparty/llm';
import { SellingAgent, type SellingAgentTurn } from './selling-agent';

export interface SessionOptions {
  readonly sessionId: string;
  readonly buyerId: string;
  readonly mandate: SellingMandate;
  readonly gateKey: KeyPair;
  readonly catalog: ReadonlyMap<string, SkuPricing>;
  readonly budget: BudgetState;
  readonly provider: LLMProvider;
  readonly sellingModel: string;
  readonly classifierModel: string;
  readonly merchantName: string;
  readonly now?: () => Date;
  /** Deterministic offer ids for replay. */
  readonly offerIdFor?: (turn: number) => string;
  /**
   * Where audit rows go. Defaults to memory.
   *
   * Injected rather than chosen here so the session stays I/O-agnostic: the
   * scenarios and tests keep an array, the console hands in a SQLite-backed
   * writer, and neither knows about the other. The chaining and hashing are
   * identical either way — they happen in `append`, not in the writer.
   */
  readonly ledger?: LedgerWriter;
}

export interface TurnResult {
  readonly turn: number;
  readonly buyerMessage: string;
  readonly agentMessage: string;
  readonly rationale: string;
  readonly signals: readonly PressureSignal[];
  readonly pressure: PressureSnapshot;
  readonly collapsedThisTurn: boolean;
  readonly offer?: SignedOffer;
  readonly refusal?: Refusal;
  readonly auditRows: number;
}

export class Session {
  private readonly agent: SellingAgent;
  private readonly now: () => Date;

  private history: Array<{ speaker: 'buyer' | 'agent'; text: string }> = [];
  private turnRecords: TurnRecord[] = [];
  private pressureState: PressureSnapshot = INITIAL_PRESSURE;
  private budgetState: BudgetState;
  private readonly ledgerState: LedgerWriter;
  private turnNumber = 0;
  private lastRefusal: Refusal | undefined;
  private offers: SignedOffer[] = [];
  /**
   * The ledger row each turn's gate decision landed on, indexed by turn - 1.
   *
   * Recorded rather than inferred. A caller wanting to show "this reply, and
   * the clause that authorized it" has to line utterances up with rows, and the
   * only two ways to do that are to ask the thing that wrote them or to count.
   * Counting breaks whenever the assumption behind the count does: a turn that
   * writes an incident row before its decision, a turn whose refusal triggers a
   * retry and so writes twice, or a ledger that already held rows from an
   * earlier session under the same id. All three happen here.
   */
  private decisionSeqs: Array<number | undefined> = [];
  /** Turns on which the ratchet tightened, so the transcript can show where. */
  private incidentTurns: number[] = [];

  constructor(private readonly options: SessionOptions) {
    this.agent = new SellingAgent(options.provider, options.sellingModel);
    this.budgetState = options.budget;
    this.now = options.now ?? (() => new Date());
    this.ledgerState = options.ledger ?? new MemoryLedger();
  }

  get pressure(): PressureSnapshot {
    return this.pressureState;
  }

  get budget(): BudgetState {
    return this.budgetState;
  }

  get ledger(): LedgerWriter {
    return this.ledgerState;
  }

  get transcript(): ReadonlyArray<{ speaker: 'buyer' | 'agent'; text: string }> {
    return this.history;
  }

  /** Every offer the gate signed this session, in order. */
  get signedOffers(): readonly SignedOffer[] {
    return this.offers;
  }

  /**
   * The audit row each turn's gate decision produced, indexed by turn - 1.
   *
   * `undefined` where a turn produced no decision at all — the agent replied
   * without proposing anything, which is an ordinary thing for it to do.
   */
  get decisionRowSeqs(): readonly (number | undefined)[] {
    return this.decisionSeqs;
  }

  /**
   * Turns on which manipulation pressure crossed a threshold.
   *
   * A turn can tighten the envelope and still produce no offer — the agent
   * replies, proposes nothing, and the only trace is an incident row. Without
   * this the transcript shows an ordinary exchange and the most important thing
   * that happened is invisible.
   */
  get incidentAtTurn(): readonly number[] {
    return this.incidentTurns;
  }

  async takeTurn(buyerMessage: string): Promise<TurnResult> {
    this.turnNumber += 1;
    const turn = this.turnNumber;
    const at = this.now();

    // --- 1 & 2. observe, from both emitters ---------------------------------
    const detectorInput = { message: buyerMessage, turn, history: this.turnRecords };
    const fromDetectors = runDetectors(detectorInput);
    const fromModel = await classifyPressure(
      this.options.provider,
      detectorInput,
      this.options.classifierModel,
    );
    const signals = [...fromDetectors, ...fromModel];

    // --- 3. decide ----------------------------------------------------------
    const verdict = reducePressure(
      this.pressureState,
      signals,
      this.options.mandate.pressure_policy,
      turn,
    );
    this.pressureState = verdict.snapshot;

    if (verdict.incident !== null) {
      this.incidentTurns = [...this.incidentTurns, turn];
      this.record({
        at: at.toISOString(),
        action: 'pressure_incident',
        outcome: 'logged',
        authorized_by: 'pressure_policy.collapse_threshold',
        clause_value: this.options.mandate.pressure_policy.collapse_threshold,
        agent_rationale: `manipulation pressure crossed the collapse threshold on turn ${turn}; discount authority is now zero`,
        evidence: verdict.incident.evidence,
      });
    }

    // --- 4. propose ---------------------------------------------------------
    const ceilingPct = pressureCeilingPct(
      this.pressureState.state,
      this.options.mandate.authority.max_discount_depth_pct,
    );

    let agentTurn = await this.agent.takeTurn({
      buyerId: this.options.buyerId,
      buyerMessage,
      history: this.history,
      catalog: this.options.catalog,
      ceilingPct,
      pressureState: this.pressureState.state,
      merchantName: this.options.merchantName,
      ...(this.lastRefusal === undefined ? {} : { lastRefusal: this.lastRefusal }),
    });

    /**
     * What the agent asked for before the gate touched it.
     *
     * Captured here rather than read off `agentTurn` at record time, because the
     * retry below reassigns `agentTurn` to a second, lower proposal. Recording
     * that one would report the number the gate dictated as the number the agent
     * wanted, which is precisely backwards — and it is the difference between
     * the two that says whether the envelope changed the outcome.
     */
    const firstProposedPct = agentTurn.proposal?.requestedDepthPct;

    // --- 5. gate ------------------------------------------------------------
    let outcome = await this.putToGate(agentTurn, turn, at, ceilingPct, firstProposedPct);

    /**
     * One retry when the gate offered a counter.
     *
     * The refusal already carries the depth the gate would sign, so a second
     * pass costs one model call and turns a dead end into a close. More than one
     * retry would let a persistent agent burn the turn budget probing its own
     * gate, which is the behaviour the pressure detectors exist to catch in a
     * buyer and should not be encouraged in the seller.
     */
    if (outcome.refusal !== undefined && outcome.refusal.counter !== undefined) {
      this.lastRefusal = outcome.refusal;
      agentTurn = await this.agent.takeTurn({
        buyerId: this.options.buyerId,
        buyerMessage,
        history: this.history,
        catalog: this.options.catalog,
        ceilingPct: outcome.refusal.counter.depthPct,
        pressureState: this.pressureState.state,
        lastRefusal: outcome.refusal,
        merchantName: this.options.merchantName,
      });
      outcome = await this.putToGate(
        agentTurn,
        turn,
        at,
        ceilingPct,
        firstProposedPct,
        `${this.offerId(turn)}_r`,
      );
    }

    this.lastRefusal = outcome.refusal;

    this.history = [
      ...this.history,
      { speaker: 'buyer', text: buyerMessage },
      { speaker: 'agent', text: agentTurn.message },
    ];
    this.turnRecords = [
      ...this.turnRecords,
      { turn, buyerMessage, refused: outcome.refusal !== undefined },
    ];

    return {
      turn,
      buyerMessage,
      agentMessage: agentTurn.message,
      rationale: agentTurn.rationale,
      signals,
      pressure: this.pressureState,
      collapsedThisTurn: verdict.incident !== null,
      ...(outcome.offer === undefined ? {} : { offer: outcome.offer }),
      ...(outcome.refusal === undefined ? {} : { refusal: outcome.refusal }),
      auditRows: this.ledgerState.rows.length,
    };
  }

  private async putToGate(
    agentTurn: SellingAgentTurn,
    turn: number,
    at: Date,
    ceilingPct: number,
    proposedPct: number | undefined,
    offerId?: string,
  ): Promise<{ offer?: SignedOffer; refusal?: Refusal }> {
    if (agentTurn.proposal === undefined) return {};

    const context: GateContext = {
      mandate: this.options.mandate,
      gateKey: this.options.gateKey,
      pricing: this.options.catalog,
      budget: this.budgetState,
      pressure: this.pressureState,
      now: at,
      offerId: offerId ?? this.offerId(turn),
    };

    const decision = evaluateQuote(agentTurn.proposal, context);

    if (!decision.ok) {
      const row = this.record({
        at: at.toISOString(),
        action: 'quote_refused',
        outcome: 'refused',
        authorized_by: decision.refusal.clause,
        agent_rationale: agentTurn.rationale || 'no rationale supplied',
        ceiling_pct: ceilingPct,
        ...(proposedPct === undefined ? {} : { proposed_depth_pct: proposedPct }),
        ...(decision.refusal.counter === undefined
          ? {}
          : { depth_pct: decision.refusal.counter.depthPct }),
      });
      this.decisionSeqs[turn - 1] = row.seq;
      return { refusal: decision.refusal };
    }

    this.budgetState = decision.budget;
    const offer = decision.offer;
    this.offers = [...this.offers, offer];
    const units = offer.lines.reduce((sum, line) => sum + line.quantity, 0);

    const row = this.record({
      at: at.toISOString(),
      action: units > 1 ? 'bundle_priced' : offer.depth_pct > 0 ? 'discount_conceded' : 'quote_issued',
      outcome: 'signed',
      authorized_by: offer.authorized_by,
      clause_value: this.clauseValue(offer.authorized_by),
      agent_rationale: agentTurn.rationale || 'no rationale supplied',
      offer_id: offer.offer_id,
      buyer_id: offer.buyer_id,
      amount_inr: offer.offered_total_inr,
      list_inr: offer.list_total_inr,
      depth_pct: offer.depth_pct,
      ceiling_pct: ceilingPct,
      ...(proposedPct === undefined ? {} : { proposed_depth_pct: proposedPct }),
      settlement_path: offer.settlement_path,
      signature: offer.signature.sig,
    });

    this.decisionSeqs[turn - 1] = row.seq;
    return { offer };
  }

  /** What the cited clause actually says, for the "(15)" in the rendered row. */
  private clauseValue(clause: string): string | number | undefined {
    const { authority, confidence_policy: confidence, pressure_policy: pressure } = this.options.mandate;
    switch (clause) {
      case 'authority.max_discount_depth_pct':
        return authority.max_discount_depth_pct;
      case 'authority.bundle_rules.combined_depth_pct':
        return authority.bundle_rules.combined_depth_pct;
      case 'authority.floor_margin_pct':
        return authority.floor_margin_pct;
      case 'authority.discount_budget_inr_per_day':
        return authority.discount_budget_inr_per_day;
      case 'authority.per_buyer_discount_cap_inr':
        return authority.per_buyer_discount_cap_inr;
      case 'confidence_policy.min_margin_confidence':
        return confidence.min_margin_confidence;
      case 'pressure_policy.collapse_threshold':
        return pressure.collapse_threshold;
      case 'pressure_policy.guard_threshold':
        return guardThreshold(pressure);
      default:
        return undefined;
    }
  }

  private record(entry: Omit<AuditEntry, 'session_id' | 'envelope_id' | 'pressure_score' | 'budget_remaining_inr' | 'budget_limit_inr'>): AuditRow {
    const position = poolPosition(this.budgetState, this.now());
    return this.ledgerState.append({
      ...entry,
      session_id: this.options.sessionId,
      envelope_id: this.options.mandate.envelope_id,
      pressure_score: this.pressureState.score,
      budget_remaining_inr: paiseToRupees(position.remaining),
      budget_limit_inr: paiseToRupees(position.limit),
    });
  }

  private offerId(turn: number): string {
    return this.options.offerIdFor?.(turn) ?? `off_${this.options.sessionId}_t${turn}`;
  }

  /** Budget left in the shared pool, for the console's burn-down gauge. */
  remainingBudgetInr(): number {
    return paiseToRupees(available(this.budgetState, this.now()));
  }
}
