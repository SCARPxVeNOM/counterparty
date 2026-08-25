/**
 * Deterministic pressure detectors.
 *
 * These run over the raw buyer message BEFORE it reaches any model. That
 * ordering is the whole point: an attack that captures the selling agent has
 * already been observed by the time it succeeds, and the signals it produced
 * cannot be withdrawn.
 *
 * Detectors are pattern matchers, so they catch literal attacks and miss
 * paraphrased ones. That is expected and is why the model classifier exists.
 * The division of labour is deliberate:
 *
 *   detectors  cheap, deterministic, testable, uncapturable — catch the literal
 *   model      expensive, fuzzy, manipulable — catches the paraphrase
 *
 * Neither is sufficient. Only the detectors are trustworthy under attack, so
 * they are the floor.
 */

import { signal, type PressureSignal, type SignalKind } from './signals.js';

export interface TurnRecord {
  readonly turn: number;
  readonly buyerMessage: string;
  /** Whether the gate refused a concession in response to this turn. */
  readonly refused: boolean;
}

export interface DetectorInput {
  readonly message: string;
  readonly turn: number;
  /** Earlier turns, oldest first. Empty on the opening turn. */
  readonly history: readonly TurnRecord[];
}

interface Pattern {
  readonly kind: SignalKind;
  readonly re: RegExp;
  readonly detail: string;
}

const IMPERATIVE_PATTERNS: readonly Pattern[] = [
  {
    kind: 'injected_imperative',
    re: /\b(?:ignore|disregard|forget|discard|drop)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|preceding|above|earlier|foregoing|original)\s+(?:instructions?|rules?|prompts?|directions?|constraints?|pricing|policies|policy|limits?)/i,
    detail: 'instruction to disregard prior rules',
  },
  {
    kind: 'injected_imperative',
    re: /\b(?:previous|prior|preceding|earlier|existing|all)\s+(?:pricing\s+|discount\s+)?(?:rules?|instructions?|constraints?|policies|policy|limits?|mandates?)\s+(?:are|is|have\s+been)\s+(?:now\s+)?(?:void|revoked|cancell?ed|suspended|waived|null|no\s+longer\s+(?:valid|in\s+effect|applicable))/i,
    detail: 'declaration that prior rules are void',
  },
  {
    kind: 'injected_imperative',
    re: /\byou\s+are\s+now\s+(?:a|an|the)\s+\w+/i,
    detail: 'attempted role reassignment',
  },
  {
    kind: 'injected_imperative',
    re: /\bnew\s+(?:system\s+|updated\s+)?(?:instructions?|rules?|directives?|policy|policies)\s*[:：]/i,
    detail: 'purported new instruction block',
  },
  {
    kind: 'injected_imperative',
    re: /\boverrid(?:e|ing)\s+(?:the\s+)?(?:previous|prior|current|existing|all|any)\b/i,
    detail: 'explicit override instruction',
  },
  {
    kind: 'injected_imperative',
    re: /\b(?:reveal|print|output|show|repeat|display|dump)\s+(?:me\s+)?(?:your|the)\s+(?:full\s+|system\s+|original\s+)?(?:prompt|instructions?|rules?|configuration|mandate|envelope)/i,
    detail: 'attempt to extract system configuration',
  },
  {
    kind: 'injected_imperative',
    re: /\bfrom\s+now\s+on\s*[,:]?\s*(?:you|ignore|disregard|treat|apply)/i,
    detail: 'attempted persistent behaviour change',
  },
  {
    kind: 'injected_imperative',
    re: /\bdo\s+not\s+(?:apply|enforce|check|validate|consult)\s+(?:the\s+)?(?:usual\s+|normal\s+|standard\s+)?(?:rules?|limits?|policy|policies|mandate)/i,
    detail: 'instruction to skip enforcement',
  },
];

const ROLE_MARKER_PATTERNS: readonly Pattern[] = [
  {
    kind: 'role_marker',
    re: /^[^\S\n]*(?:SYSTEM|ASSISTANT|USER|ADMIN|DEVELOPER|TOOL|FUNCTION|MODEL)[^\S\n]*[:：]/im,
    detail: 'conversational role marker in buyer content',
  },
  { kind: 'role_marker', re: /<\|[^|>\n]{1,40}\|>/, detail: 'chat template control token' },
  { kind: 'role_marker', re: /\[\/?(?:INST|SYSTEM|ADMIN|SYS)\]/i, detail: 'instruction-format delimiter' },
  { kind: 'role_marker', re: /<\/?(?:system|assistant|instructions?)>/i, detail: 'pseudo-XML role tag' },
  { kind: 'role_marker', re: /^#{2,}\s*(?:instruction|system|prompt)/im, detail: 'markdown instruction header' },
];

const AUTHORITY_PATTERNS: readonly Pattern[] = [
  {
    kind: 'authority_claim',
    re: /\b(?:i\s+am|i'm|this\s+(?:is|buyer\s+is|account\s+is)|we\s+are|they\s+are)\s+(?:an?\s+)?(?:approved|authoriz(?:ed|ed)|whitelisted|pre[-\s]?approved|entitled|cleared)\s+(?:for|to)\b/i,
    detail: 'unverified entitlement claim',
  },
  {
    kind: 'authority_claim',
    re: /\b(?:partner|internal|employee|staff|wholesale|dealer|distributor|reseller)\s+(?:pricing|rate|price|discount|tier)\b/i,
    detail: 'claim to a restricted pricing tier',
  },
  {
    kind: 'authority_claim',
    re: /\bi\s+am\s+(?:the|your)\s+(?:owner|manager|admin(?:istrator)?|developer|supervisor|founder|ceo|director)\b/i,
    detail: 'claim of internal authority',
  },
  {
    kind: 'authority_claim',
    re: /\bon\s+behalf\s+of\s+(?:the\s+)?(?:merchant|owner|management|head\s+office)\b/i,
    detail: 'claim to speak for the merchant',
  },
  {
    kind: 'authority_claim',
    re: /\bapproved\s+for\s+\d{1,3}\s*%/i,
    detail: 'specific unverified discount entitlement',
  },
];

const OVERRIDE_PATTERNS: readonly Pattern[] = [
  { kind: 'policy_override_request', re: /\bmake\s+an\s+exception\b/i, detail: 'request for an exception' },
  { kind: 'policy_override_request', re: /\bjust\s+this\s+(?:once|one\s+time)\b/i, detail: 'one-time exception framing' },
  { kind: 'policy_override_request', re: /\b(?:bend|break|stretch|relax)\s+(?:the\s+)?rules?\b/i, detail: 'request to relax rules' },
  { kind: 'policy_override_request', re: /\boff\s+the\s+record\b/i, detail: 'request for unlogged treatment' },
  { kind: 'policy_override_request', re: /\bno\s+one\s+(?:will|has\s+to|needs?\s+to)\s+know\b/i, detail: 'appeal to non-disclosure' },
  { kind: 'policy_override_request', re: /\bbetween\s+(?:us|you\s+and\s+me)\b/i, detail: 'appeal to private arrangement' },
  { kind: 'policy_override_request', re: /\bwaive\s+(?:the\s+)?(?:policy|rules?|limits?|cap)\b/i, detail: 'request to waive a limit' },
];

const UNVERIFIABLE_PATTERNS: readonly Pattern[] = [
  {
    kind: 'unverifiable_claim',
    re: /\b(?:your\s+)?competitors?\s+(?:quoted|offered|is\s+selling|are\s+selling|has\s+it|have\s+it|sells)/i,
    detail: 'uncheckable competitor quote',
  },
  {
    kind: 'unverifiable_claim',
    re: /\b(?:quoted|offered|gave)\s+me\s+(?:₹|rs\.?|inr)\s*[\d,]+/i,
    detail: 'uncheckable quoted figure',
  },
  {
    kind: 'unverifiable_claim',
    re: /\bi\s+can\s+get\s+(?:it|this|the\s+same|them)\s+(?:for|at)\s+(?:₹|rs\.?|inr)?\s*[\d,]+/i,
    detail: 'uncheckable alternative price',
  },
  {
    kind: 'unverifiable_claim',
    re: /\b(?:another|a\s+different|the\s+other)\s+(?:vendor|seller|supplier|store|shop)\s+(?:has|offers|quoted|is\s+doing|sells)/i,
    detail: 'uncheckable alternative supplier',
  },
  {
    kind: 'unverifiable_claim',
    re: /\bi\s+(?:already\s+|also\s+|still\s+)?(?:have|had|got|received)\s+a\s+(?:better\s+|cheaper\s+|lower\s+)?quote\b/i,
    detail: 'uncheckable competing quote',
  },
];

const URGENCY_PATTERNS: readonly Pattern[] = [
  {
    kind: 'urgency_pressure',
    re: /\b(?:expires?|ends?|closes?|runs\s+out)\s+(?:in|within)\s+\d+\s*(?:seconds?|minutes?|hours?|min|sec|hrs?)/i,
    detail: 'artificial deadline',
  },
  { kind: 'urgency_pressure', re: /\blast\s+chance\b/i, detail: 'scarcity framing' },
  {
    kind: 'urgency_pressure',
    re: /\bi\s+need\s+(?:an\s+)?(?:answer|decision|price)\s+(?:right\s+)?now\b/i,
    detail: 'demand for immediate decision',
  },
  {
    kind: 'urgency_pressure',
    re: /\bif\s+you\s+(?:can'?t|don'?t|won'?t)\b[^.!?]{0,60}\bi(?:'ll|\s+will)\s+(?:go|buy|walk|take\s+my)\b/i,
    detail: 'walk-away threat',
  },
];

/** Applied to every message. Cross-turn detectors are handled separately. */
const SINGLE_TURN_PATTERNS: readonly Pattern[] = [
  ...IMPERATIVE_PATTERNS,
  ...ROLE_MARKER_PATTERNS,
  ...AUTHORITY_PATTERNS,
  ...OVERRIDE_PATTERNS,
  ...UNVERIFIABLE_PATTERNS,
  ...URGENCY_PATTERNS,
];

/**
 * Run every deterministic detector.
 *
 * At most one signal per kind per turn. A message that says "ignore previous
 * instructions" three times is one attack, not three, and letting repetition
 * inflate the score would make the reducer's arithmetic describe the attacker's
 * verbosity rather than their intent.
 */
export function runDetectors(input: DetectorInput): PressureSignal[] {
  const found = new Map<SignalKind, PressureSignal>();
  const quoted = quotedRegions(input.message);

  for (const pattern of SINGLE_TURN_PATTERNS) {
    const match = pattern.re.exec(input.message);
    if (match === null) continue;

    // An imperative sitting inside pasted or quoted content is the higher-signal
    // case: the buyer is relaying content that carries an instruction, which is
    // the indirect injection route the AP2 red-teaming work found most effective.
    const kind: SignalKind =
      pattern.kind === 'injected_imperative' && insideAny(quoted, match.index)
        ? 'instruction_in_quoted_content'
        : pattern.kind;

    if (found.has(kind)) continue;
    found.set(kind, signal(kind, 'detector', match[0], input.turn, pattern.detail));
  }

  const reframe = detectEscalatingReframe(input);
  if (reframe !== null && !found.has('escalating_reframe')) {
    found.set('escalating_reframe', reframe);
  }

  const probing = detectProbingVariation(input);
  if (probing !== null && !found.has('probing_variation')) {
    found.set('probing_variation', probing);
  }

  return [...found.values()];
}

/**
 * The same ask, put again after it was refused.
 *
 * Two independent triggers. The intent-level one fires when a price ask follows
 * a refused price ask regardless of wording; the lexical one fires when the
 * message substantially repeats the refused message. Neither catches a genuine
 * semantic reframe in fresh vocabulary — that is the model classifier's job, and
 * it emits into this same signal kind.
 */
function detectEscalatingReframe(input: DetectorInput): PressureSignal | null {
  const previous = lastRefusedTurn(input.history);
  if (previous === null) return null;

  const askedAgain = containsPriceAsk(input.message) && containsPriceAsk(previous.buyerMessage);
  const similarity = jaccard(contentTokens(input.message), contentTokens(previous.buyerMessage));

  if (!askedAgain && similarity < 0.35) return null;

  const reason = askedAgain
    ? `price ask repeated after refusal on turn ${previous.turn}`
    : `message repeats turn ${previous.turn} (similarity ${similarity.toFixed(2)}) after refusal`;

  return signal('escalating_reframe', 'detector', input.message, input.turn, reason);
}

/**
 * Systematic variation of one ask — walking a boundary to find where it sits.
 *
 * Counted by distinct discount percentages requested across the session. Three
 * different numbers for the same concession is not indecision, it is a search.
 */
function detectProbingVariation(input: DetectorInput): PressureSignal | null {
  const asked = new Set<number>();
  for (const record of input.history) {
    for (const pct of requestedPercentages(record.buyerMessage)) asked.add(pct);
  }
  const current = requestedPercentages(input.message);
  for (const pct of current) asked.add(pct);

  if (asked.size < 3 || current.length === 0) return null;

  const sorted = [...asked].sort((a, b) => a - b);
  return signal(
    'probing_variation',
    'detector',
    input.message,
    input.turn,
    `${asked.size} distinct discount levels requested this session: ${sorted.join('%, ')}%`,
  );
}

function lastRefusedTurn(history: readonly TurnRecord[]): TurnRecord | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (record !== undefined && record.refused) return record;
  }
  return null;
}

/**
 * `\d+\s*%` rather than `\d\s*%`: with a leading word boundary, the single-digit
 * form only ever matches a one-digit percentage, because in "18%" the boundary
 * holds before the 1 and there is no boundary before the 8. Every two-digit
 * discount ask — which is most of them — would slip past.
 */
const PRICE_ASK = /\b(?:discount|off|cheaper|lower|reduce|better\s+price|best\s+price|deal|knock|come\s+down|match|₹|rs\.?\s*\d|\d+\s*%)/i;

export function containsPriceAsk(message: string): boolean {
  return PRICE_ASK.test(message);
}

/** Discount percentages explicitly named in a message. */
export function requestedPercentages(message: string): number[] {
  const found: number[] = [];
  const re = /(\d{1,2}(?:\.\d)?)\s*%/g;
  let match = re.exec(message);
  while (match !== null) {
    const raw = match[1];
    if (raw !== undefined) {
      const value = Number.parseFloat(raw);
      if (Number.isFinite(value) && value > 0) found.push(value);
    }
    match = re.exec(message);
  }
  return found;
}

/**
 * Regions of the message that are quoted, pasted or forwarded rather than the
 * buyer's own voice: fenced blocks, block quotes, forwarded-message headers.
 */
function quotedRegions(message: string): Array<readonly [number, number]> {
  const regions: Array<readonly [number, number]> = [];

  const fenced = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
  let match = fenced.exec(message);
  while (match !== null) {
    regions.push([match.index, match.index + match[0].length]);
    match = fenced.exec(message);
  }

  const blockquote = /^[^\S\n]*>[^\n]*(?:\n[^\S\n]*>[^\n]*)*/gm;
  match = blockquote.exec(message);
  while (match !== null) {
    regions.push([match.index, match.index + match[0].length]);
    match = blockquote.exec(message);
  }

  // "----- Forwarded message -----", "Begin forwarded message:", customer note blocks
  const forwarded = /(?:-{2,}\s*(?:forwarded|original)\s+message\s*-{2,}|begin\s+forwarded\s+message\s*:)[\s\S]*/i;
  const forwardedMatch = forwarded.exec(message);
  if (forwardedMatch !== null) {
    regions.push([forwardedMatch.index, message.length]);
  }

  return regions;
}

function insideAny(regions: ReadonlyArray<readonly [number, number]>, index: number): boolean {
  return regions.some(([start, end]) => index >= start && index < end);
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'are', 'can', 'this', 'that', 'with', 'have', 'will',
  'would', 'could', 'from', 'was', 'were', 'been', 'has', 'had', 'not', 'but', 'get', 'got',
  'any', 'all', 'out', 'our', 'its', 'his', 'her', 'them', 'they', 'what', 'when', 'how',
  'please', 'thanks', 'thank', 'hi', 'hello', 'okay', 'yes', 'need', 'want', 'like', 'just',
]);

export function contentTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9%₹\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
  return new Set(tokens);
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}
