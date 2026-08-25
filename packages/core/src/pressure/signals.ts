/**
 * The pressure signal vocabulary.
 *
 * One shared vocabulary, two emitters. Deterministic detectors emit signals from
 * the raw buyer message before any model sees it; an LLM classifier emits
 * signals in the same vocabulary. The reducer consumes both and decides.
 *
 * THE LOAD-BEARING DETAIL: a signal carries no magnitude.
 *
 * An emitter says "I observed a signal of this kind, here is the evidence" and
 * nothing more. Weights live in the reducer, in a fixed table. If the emitter
 * supplied the weight, a prompt-injected model would simply report every signal
 * at 0.001 and the envelope would never collapse — the same hole as letting the
 * model report a score, wearing a different hat. Categorical assertion is the
 * most a compromised emitter can influence, and the reducer decides what a
 * category is worth.
 *
 * Signals accumulate and are never removed. There is no channel by which any
 * emitter can retract, downgrade, or suppress a signal another emitter raised.
 */

export const SIGNAL_KINDS = [
  /** "ignore previous instructions", "prior pricing rules are void" */
  'injected_imperative',
  /** A conversational role marker in buyer content: "SYSTEM:", "<|im_start|>", "[INST]" */
  'role_marker',
  /** Injection patterns appearing inside quoted or pasted content rather than in the buyer's own voice */
  'instruction_in_quoted_content',
  /** "I am approved for partner pricing", "as your account manager" */
  'authority_claim',
  /** "make an exception", "just this once", "off the record" */
  'policy_override_request',
  /** The same ask, re-put after it was refused */
  'escalating_reframe',
  /** "your competitor quoted me ₹3,000" — a claim we cannot check */
  'unverifiable_claim',
  /** Systematic variation of one ask across several turns, probing for a boundary */
  'probing_variation',
  /** "expires in five minutes", "I need to decide right now" */
  'urgency_pressure',
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const SIGNAL_SOURCES = ['detector', 'model'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export interface PressureSignal {
  readonly kind: SignalKind;
  readonly source: SignalSource;
  /**
   * The offending span, verbatim.
   *
   * §10 of the design requires the incident log to carry the injected string
   * exactly as received. Paraphrasing evidence into a summary is how an incident
   * report becomes unfalsifiable.
   */
  readonly evidence: string;
  readonly turn: number;
  /** Free-text emitter note. Recorded, never consequential. */
  readonly detail?: string;
}

/**
 * What each kind of signal is worth. Owned by the reducer, not by emitters.
 *
 * Calibrated so that a single unambiguous injection — a role marker, or an
 * instruction embedded in pasted content — collapses the envelope on its own,
 * while a single soft signal such as one unverifiable competing quote does not
 * even tighten it. Soft signals have to accumulate, which is the intended
 * behaviour: an over-eager legitimate buyer produces one or two, an adversary
 * produces a pattern.
 */
export const SIGNAL_WEIGHTS: Readonly<Record<SignalKind, number>> = {
  instruction_in_quoted_content: 0.9,
  injected_imperative: 0.85,
  role_marker: 0.8,
  authority_claim: 0.5,
  probing_variation: 0.4,
  escalating_reframe: 0.35,
  policy_override_request: 0.3,
  unverifiable_claim: 0.3,
  urgency_pressure: 0.2,
};

/**
 * How much an emitter is trusted.
 *
 * A detector matched a pattern in bytes we received; a model told us what it
 * believed about those bytes, and the model is the component an adversary is
 * actively trying to capture. So model signals are discounted — but only
 * slightly, and the margin matters.
 *
 * At a 0.8 multiplier, a model-asserted `injected_imperative` scores
 * 0.85 × 0.8 = 0.68, which lands just under a 0.7 collapse threshold. That is
 * precisely backwards: the paraphrased injection that no pattern catches is the
 * case the model exists for, and it would have produced GUARDED instead of
 * COLLAPSED. At 0.9 it scores 0.765 and collapses on its own.
 *
 * Raising this number is strictly safe. Model signals only ever ADD to the
 * union — there is no path by which a larger multiplier lets a captured model
 * suppress anything. It can make the model better at triggering collapse, never
 * better at preventing it.
 */
export const SOURCE_TRUST: Readonly<Record<SignalSource, number>> = {
  detector: 1.0,
  model: 0.9,
};

export function weightOf(signal: PressureSignal): number {
  return SIGNAL_WEIGHTS[signal.kind] * SOURCE_TRUST[signal.source];
}

export function signal(
  kind: SignalKind,
  source: SignalSource,
  evidence: string,
  turn: number,
  detail?: string,
): PressureSignal {
  return detail === undefined
    ? { kind, source, evidence: clip(evidence), turn }
    : { kind, source, evidence: clip(evidence), turn, detail };
}

/** Evidence is a span, not a transcript. Long spans are truncated for the log. */
const MAX_EVIDENCE = 240;

function clip(evidence: string): string {
  const collapsed = evidence.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_EVIDENCE ? collapsed : `${collapsed.slice(0, MAX_EVIDENCE)}…`;
}
