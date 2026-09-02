/**
 * The retry policy, proven against a scripted upstream.
 *
 * None of this calls Gemini. The behaviour under test is entirely a function of
 * what the upstream throws, so a fake that throws on cue tests it exactly and
 * costs nothing — which is the same reason the cassette exists one layer up.
 */

import { describe, expect, it } from 'vitest';
import { RetryingProvider, classifyFailure, type AttemptNote } from '../src/retry';
import {
  LlmError,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
} from '../src/provider';

const ask: GenerateRequest = {
  model: 'model-a',
  messages: [{ role: 'user', text: 'hello' }],
  label: 'test-call',
};

const fallbacks = { 'model-a': ['model-b', 'model-c'] } as const;

/** Fails with the given errors in order, then answers, recording every model asked. */
class FlakyUpstream implements LLMProvider {
  readonly name = 'flaky';
  readonly asked: string[] = [];
  private index = 0;

  constructor(private readonly failures: readonly (LlmError | Error)[]) {}

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.asked.push(request.model);
    const failure = this.failures[this.index];
    this.index += 1;
    if (failure !== undefined) throw failure;
    return { text: 'ok', model: request.model, fromCassette: false };
  }
}

const busy = (): LlmError => new LlmError('model is busy', 'PROVIDER_ERROR', { status: 503 });
const outOfQuota = (): LlmError =>
  new LlmError('quota exceeded', 'PROVIDER_ERROR', { status: 429 });
const badKey = (): LlmError => new LlmError('API key not valid', 'PROVIDER_ERROR', { status: 401 });

/** Collects the waits instead of serving them, so the suite stays instant. */
function fakeClock(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe('classifyFailure', () => {
  it('separates a busy model from a spent quota from a bad key', () => {
    expect(classifyFailure(busy())).toBe('transient');
    expect(classifyFailure(outOfQuota())).toBe('quota');
    expect(classifyFailure(badKey())).toBe('fatal');
  });

  it('treats a statusless provider error as a call that never landed', () => {
    expect(classifyFailure(new LlmError('socket hang up', 'PROVIDER_ERROR'))).toBe('transient');
  });

  it('does not retry things asking again cannot change', () => {
    expect(classifyFailure(new LlmError('no key', 'NO_API_KEY'))).toBe('fatal');
    expect(classifyFailure(new LlmError('bad json', 'BAD_JSON'))).toBe('fatal');
    expect(classifyFailure(new LlmError('empty', 'EMPTY_RESPONSE'))).toBe('fatal');
  });
});

describe('RetryingProvider', () => {
  it('rides out the 503 that a real key actually returns half the time', async () => {
    const upstream = new FlakyUpstream([busy(), busy()]);
    const clock = fakeClock();
    const provider = new RetryingProvider(upstream, { sleep: clock.sleep, baseDelayMs: 100 });

    const result = await provider.generate(ask);

    expect(result.text).toBe('ok');
    expect(upstream.asked).toEqual(['model-a', 'model-a', 'model-a']);
  });

  it('backs off exponentially rather than hammering', async () => {
    const upstream = new FlakyUpstream([busy(), busy()]);
    const clock = fakeClock();
    await new RetryingProvider(upstream, { sleep: clock.sleep, baseDelayMs: 100 }).generate(ask);

    expect(clock.waits).toEqual([100, 200]);
  });

  it('moves to the next model once a model has exhausted its attempts', async () => {
    const upstream = new FlakyUpstream([busy(), busy(), busy()]);
    const clock = fakeClock();
    const provider = new RetryingProvider(upstream, { sleep: clock.sleep, fallbacks });

    const result = await provider.generate(ask);

    expect(upstream.asked).toEqual(['model-a', 'model-a', 'model-a', 'model-b']);
    expect(result.model).toBe('model-b');
  });

  it('abandons a quota-exhausted model immediately instead of retrying it', async () => {
    const upstream = new FlakyUpstream([outOfQuota()]);
    const clock = fakeClock();
    const provider = new RetryingProvider(upstream, { sleep: clock.sleep, fallbacks });

    const result = await provider.generate(ask);

    // One try on model-a, not three: waiting does not refill a quota.
    expect(upstream.asked).toEqual(['model-a', 'model-b']);
    expect(clock.waits).toEqual([]);
    expect(result.model).toBe('model-b');
  });

  it('does not retry a bad key, however many fallbacks are configured', async () => {
    const upstream = new FlakyUpstream([badKey()]);
    const provider = new RetryingProvider(upstream, { sleep: fakeClock().sleep, fallbacks });

    await expect(provider.generate(ask)).rejects.toThrow('API key not valid');
    expect(upstream.asked).toEqual(['model-a']);
  });

  it('surfaces the last failure when the whole chain is down', async () => {
    const upstream = new FlakyUpstream(Array.from({ length: 12 }, busy));
    const clock = fakeClock();
    const provider = new RetryingProvider(upstream, { sleep: clock.sleep, fallbacks });

    await expect(provider.generate(ask)).rejects.toThrow('model is busy');
    expect(upstream.asked).toEqual([
      'model-a', 'model-a', 'model-a',
      'model-b', 'model-b', 'model-b',
      'model-c', 'model-c', 'model-c',
    ]);
  });

  it('reports each failure so an operator can see why a demo paused', async () => {
    const notes: AttemptNote[] = [];
    const upstream = new FlakyUpstream([busy(), outOfQuota()]);
    const clock = fakeClock();
    await new RetryingProvider(upstream, {
      sleep: clock.sleep,
      fallbacks,
      onAttempt: (note) => notes.push(note),
    }).generate(ask);

    expect(notes.map((n) => n.kind)).toEqual(['transient', 'quota']);
    expect(notes[1]?.nextModel).toBe('model-b');
  });

  it('leaves the request otherwise untouched when it swaps the model', async () => {
    const seen: GenerateRequest[] = [];
    const upstream: LLMProvider = {
      name: 'recorder',
      generate: async (request) => {
        seen.push(request);
        if (request.model === 'model-a') throw outOfQuota();
        return { text: 'ok', model: request.model, fromCassette: false };
      },
    };
    await new RetryingProvider(upstream, { sleep: fakeClock().sleep, fallbacks }).generate({
      ...ask,
      system: 'you are a seller',
      temperature: 0.2,
    });

    expect(seen[1]?.system).toBe('you are a seller');
    expect(seen[1]?.temperature).toBe(0.2);
    expect(seen[1]?.label).toBe('test-call');
  });
});
