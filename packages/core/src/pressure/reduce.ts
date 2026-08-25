/**
 * The collapse decision.
 *
 * Pure. Data in, data out. No model call, no clock, no I/O. That is what makes
 * the adversarial corpus runnable as ordinary unit tests: every case in the
 * suite is a signal array and an expected verdict, and none of them cost a
 * token or vary between runs.
 *
 * Two properties this module guarantees, both by construction rather than by
 * assertion:
 *
 *   MONOTONIC SCORE. Signals combine by probabilistic OR:
 *       score = 1 - Π(1 - wᵢ)
 *   Every weight is in [0,1), so adding a signal multiplies the product by a
 *   factor ≤ 1, which can only decrease the product and therefore only increase
 *   the score. There is no signal an emitter can add that lowers pressure. A
 *   captured model cannot argue the score down because it has no subtractive
 *   move available to it.
 *
 *   The guarantee is non-decreasing, not strictly increasing. In exact
 *   arithmetic the score approaches 1 without reaching it; in float64 the
 *   surviving product underflows against 1 after a few dozen signals and the
 *   score saturates at exactly 1. Nothing downstream cares — every threshold is
 *   ≤ 1 and the state has long since ratcheted — but the weaker claim is the
 *   true one.
 *
 *   MONOTONIC STATE. NORMAL → GUARDED → COLLAPSED, never backwards within a
 *   session. Without this, the attack is: inject, collapse, send one innocuous
 *   message, exploit the restored authority. The defence would last exactly one
 *   turn. Only human review resets it.
 */

import type { CollapseAction, PressurePolicy } from '../mandate/schema';
import { guardThreshold } from '../mandate/schema';
import { weightOf, type PressureSignal } from './signals';

export const PRESSURE_STATES = ['NORMAL', 'GUARDED', 'COLLAPSED'] as const;
export type PressureState = (typeof PRESSURE_STATES)[number];

const RANK: Readonly<Record<PressureState, number>> = {
  NORMAL: 0,
  GUARDED: 1,
  COLLAPSED: 2,
};

export interface PressureSnapshot {
  readonly state: PressureState;
  /** Session-cumulative score over every signal seen so far. */
  readonly score: number;
  /** This turn's signals alone. For display; never drives the state. */
  readonly turnScore: number;
  /** Every signal accumulated this session. Signals are never removed. */
  readonly signals: readonly PressureSignal[];
  readonly turn: number;
}

export const INITIAL_PRESSURE: PressureSnapshot = {
  state: 'NORMAL',
  score: 0,
  turnScore: 0,
  signals: [],
  turn: 0,
};

export interface PressureIncident {
  readonly turn: number;
  readonly score: number;
  /** Contributing signals, strongest first. */
  readonly signals: readonly PressureSignal[];
  /**
   * The offending strings, verbatim and deduplicated.
   *
   * §10 requires the incident log to carry what was actually received. A
   * summary would be an unfalsifiable account of an attack, which is the thing
   * this system exists not to produce.
   */
  readonly evidence: readonly string[];
}

export interface PressureVerdict {
  readonly snapshot: PressureSnapshot;
  readonly previousState: PressureState;
  /** True only on the turn the state actually moved. */
  readonly transitioned: boolean;
  /**
   * The envelope's `on_collapse` actions, returned only on the turn the state
   * transitions INTO collapsed. Notifying a human once is a response; notifying
   * them every turn afterwards is noise that trains them to ignore it.
   */
  readonly actions: readonly CollapseAction[];
  readonly incident: PressureIncident | null;
}

/**
 * Fold new signals into the session's pressure state.
 *
 * `incoming` may come from detectors, from the model classifier, or both. The
 * reducer does not care which, beyond the per-source trust weighting applied in
 * `weightOf`. Signals union; nothing is ever removed or downgraded.
 */
export function reducePressure(
  previous: PressureSnapshot,
  incoming: readonly PressureSignal[],
  policy: PressurePolicy,
  turn: number,
): PressureVerdict {
  const signals = [...previous.signals, ...incoming];
  const score = combine(signals);
  const turnScore = combine(incoming);

  const indicated = stateForScore(score, policy);
  // The ratchet. `previous.state` is a floor, never a starting point to fall from.
  const state = RANK[indicated] > RANK[previous.state] ? indicated : previous.state;

  const snapshot: PressureSnapshot = { state, score, turnScore, signals, turn };
  const transitioned = state !== previous.state;
  const collapsedNow = transitioned && state === 'COLLAPSED';

  return {
    snapshot,
    previousState: previous.state,
    transitioned,
    actions: collapsedNow ? policy.on_collapse : [],
    incident: collapsedNow ? incidentFrom(signals, score, turn) : null,
  };
}

/**
 * Probabilistic OR over signal weights.
 *
 * Chosen over a sum because it is bounded without clamping, gives diminishing
 * returns on repeated weak signals, and is non-decreasing in every input — the
 * monotonicity the whole design depends on falls out of the arithmetic rather
 * than being enforced on top of it.
 */
export function combine(signals: readonly PressureSignal[]): number {
  let survives = 1;
  for (const each of signals) {
    survives *= 1 - weightOf(each);
  }
  return 1 - survives;
}

export function stateForScore(score: number, policy: PressurePolicy): PressureState {
  if (score >= policy.collapse_threshold) return 'COLLAPSED';
  if (score >= guardThreshold(policy)) return 'GUARDED';
  return 'NORMAL';
}

/**
 * The discount ceiling that the pressure state permits, given the mandate's own
 * ceiling. The gate takes the lower of this and every other applicable clause.
 *
 * GUARDED halves the ceiling rather than zeroing it. The intermediate state has
 * to mean something, or the ratchet is really just a two-state machine with an
 * extra label: the agent tightens, keeps negotiating, and the buyer who was
 * merely over-eager rather than adversarial can still close.
 */
export function pressureCeilingPct(state: PressureState, mandateCeilingPct: number): number {
  switch (state) {
    case 'COLLAPSED':
      return 0;
    case 'GUARDED':
      return mandateCeilingPct / 2;
    case 'NORMAL':
      return mandateCeilingPct;
  }
}

/**
 * Clear pressure after a human has reviewed the session.
 *
 * The only way out of COLLAPSED, and it takes a named reviewer. Accumulated
 * signals are preserved in the returned snapshot's history even though they no
 * longer score, because the incident record should survive the decision to
 * forgive it.
 */
export function resetAfterHumanReview(
  snapshot: PressureSnapshot,
  reviewer: string,
): { readonly snapshot: PressureSnapshot; readonly clearedSignals: readonly PressureSignal[] } {
  if (reviewer.trim() === '') {
    throw new Error('a human review reset requires a named reviewer');
  }
  return {
    snapshot: { ...INITIAL_PRESSURE, turn: snapshot.turn },
    clearedSignals: snapshot.signals,
  };
}

function incidentFrom(
  signals: readonly PressureSignal[],
  score: number,
  turn: number,
): PressureIncident {
  const ranked = [...signals].sort((a, b) => weightOf(b) - weightOf(a));
  const evidence: string[] = [];
  for (const each of ranked) {
    if (!evidence.includes(each.evidence)) evidence.push(each.evidence);
  }
  return { turn, score, signals: ranked, evidence };
}
