/**
 * Surviving a model that is merely busy.
 *
 * WHY THIS EXISTS. Testing five API keys against `gemini-3.7-flash` produced
 * this, four attempts per key, three seconds apart:
 *
 *     KEY_4: OK | OK | 503 | 503
 *     KEY_5: OK | 503 | OK | 503
 *
 * The failure does not follow the key. It follows the model — `503 UNAVAILABLE`
 * is Google saying that model is at capacity right now, and at that moment it
 * was roughly a coin flip. A provider with no retry turns a coin flip into a
 * broken demo.
 *
 * TWO FAILURES, TWO REMEDIES. They are not the same and must not be treated the
 * same:
 *
 *   - `503`/`5xx` — the model is busy. Waiting helps. Retry it, backing off.
 *   - `429` — the quota is spent. Waiting does not help inside a rate window,
 *     and hammering a quota error is how a key gets throttled harder. Stop
 *     asking this model and ask a different one, whose quota is its own.
 *     (`gemini-3.1-pro-preview` returns exactly this on the free tier, on every
 *     key, which is what makes the distinction concrete rather than theoretical.)
 *
 * Anything else — 400, 401, 404 — is a fact about the request, not the weather.
 * Retrying a wrong key produces the same wrong key, slower. Those throw at once.
 *
 * WHAT THIS DOES NOT TOUCH. Swapping models mid-flight is safe here in a way it
 * would not be in most systems, and for a reason that is the whole thesis: no
 * commercial commitment is downstream of which model answered. The model
 * proposes; the gate signs. A fallback changes the prose and nothing that binds.
 */

import {
  LlmError,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
} from './provider';

export type FailureKind = 'transient' | 'quota' | 'fatal';

/**
 * Retry, switch model, or give up.
 *
 * Errors with no HTTP status at all are the interesting case. A `PROVIDER_ERROR`
 * without a status is a call that never got an answer — DNS, a reset socket, a
 * timeout — which is transient. Every other statusless code (`BAD_JSON`,
 * `EMPTY_RESPONSE`, `NO_API_KEY`) describes something we already received or
 * already know, and asking again changes nothing.
 */
export function classifyFailure(error: unknown): FailureKind {
  if (!(error instanceof LlmError)) return 'transient';

  if (error.status === undefined) {
    return error.code === 'PROVIDER_ERROR' ? 'transient' : 'fatal';
  }
  if (error.status === 429) return 'quota';
  return error.status >= 500 ? 'transient' : 'fatal';
}

export interface AttemptNote {
  readonly model: string;
  readonly attempt: number;
  readonly kind: FailureKind;
  readonly message: string;
  readonly waitMs: number;
  /** Set when this failure ends the run on `model` and moves to another. */
  readonly nextModel?: string;
}

export interface RetryOptions {
  /** Tries on each model before moving on. Default 3. */
  readonly attemptsPerModel?: number;
  /** First backoff; doubles each attempt. Default 500ms. */
  readonly baseDelayMs?: number;
  /** Model id → the models to try after it, in order. */
  readonly fallbacks?: Readonly<Record<string, readonly string[]>>;
  /** Injectable so tests do not spend real seconds proving backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called on every failed attempt, for an operator watching a demo. */
  readonly onAttempt?: (note: AttemptNote) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps any provider with the policy above.
 *
 * Sits *below* the cassette deliberately. The cassette keys on the model that
 * was asked for, so a recording made after a fallback still replays for the
 * original request — while the entry records which model actually answered.
 */
export class RetryingProvider implements LLMProvider {
  readonly name: string;

  constructor(
    private readonly upstream: LLMProvider,
    private readonly options: RetryOptions = {},
  ) {
    this.name = `retrying(${upstream.name})`;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const attempts = this.options.attemptsPerModel ?? 3;
    const baseDelayMs = this.options.baseDelayMs ?? 500;
    const sleep = this.options.sleep ?? defaultSleep;
    const chain = [request.model, ...(this.options.fallbacks?.[request.model] ?? [])];

    for (const [index, model] of chain.entries()) {
      const nextModel = chain[index + 1];

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await this.upstream.generate({ ...request, model });
        } catch (error) {
          const kind = classifyFailure(error);
          if (kind === 'fatal') throw error;

          // A spent quota does not recover between attempts, so it burns the
          // whole model rather than one try.
          const doneWithModel = kind === 'quota' || attempt === attempts;
          if (doneWithModel && nextModel === undefined) throw error;

          const waitMs = doneWithModel ? 0 : baseDelayMs * 2 ** (attempt - 1);
          this.options.onAttempt?.({
            model,
            attempt,
            kind,
            message: (error as Error).message,
            waitMs,
            ...(doneWithModel && nextModel !== undefined ? { nextModel } : {}),
          });

          if (doneWithModel) break;
          await sleep(waitMs);
        }
      }
    }

    // Unreachable: the loop above returns, or throws once the chain is spent.
    throw new LlmError(`no model in [${chain.join(', ')}] was reachable`, 'PROVIDER_ERROR');
  }
}

/** A reporter suitable for a terminal, so a stalled demo explains itself. */
export function reportAttempt(note: AttemptNote): void {
  const what =
    note.kind === 'quota'
      ? `${note.model} is out of quota`
      : `${note.model} is busy (attempt ${note.attempt})`;
  const then =
    note.nextModel === undefined ? `retrying in ${note.waitMs}ms` : `falling back to ${note.nextModel}`;
  console.error(`  llm: ${what} — ${then}`);
}
