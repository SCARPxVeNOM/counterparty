/**
 * The console's Gemini turns, replayed with no key and no network.
 *
 * WHAT THIS IS FOR. `cassettes/console/` holds real Gemini responses, recorded
 * by `pnpm record:cassettes`. A recording is only worth anything if it actually
 * hits, and a cassette hit depends on the request hashing identically — same
 * system prompt, same history, same model. Any change to the selling agent's
 * prompt, the catalog, the mandate's ceilings or the model routing silently
 * invalidates every recording. Silently, because nothing else would notice: the
 * console would just start throwing CASSETTE_MISS in front of whoever is
 * driving it.
 *
 * So this fails loudly instead, in CI, offline.
 *
 * THE SECOND THING IT PROVES, which matters more. These runs are driven by real
 * model prose and adjudicated by the real gate — signing over real canonical
 * bytes with a real Ed25519 key, refusing on real clause paths. The model is
 * fixed; nothing downstream of it is. When the injector's envelope collapses
 * below, that is the detectors and the reducer deciding it now, not a recorded
 * verdict being read back.
 */

import { describe, expect, it } from 'vitest';
import { PERSONAS, Session } from '@counterparty/agents';
import { MODELS, type Config } from '@counterparty/config';
import { createProvider } from '@counterparty/llm';
import {
  CATALOG,
  CONSOLE_CASSETTE_DIR,
  CONSOLE_SESSION_ID,
  DEMO_MERCHANT,
  consoleTurns,
  demoBudget,
  demoMandate,
  gateKey,
} from '@counterparty/demo';

/**
 * Deliberately keyless.
 *
 * Passed explicitly rather than read from .env, so this test means the same
 * thing on a machine that has a Gemini key as on one that does not. With no key
 * the upstream is `UnavailableProvider`, which makes a network call impossible
 * rather than merely unlikely — a cassette miss throws instead of quietly
 * costing a token and passing.
 */
const KEYLESS: Config = {
  razorpayKeyId: '',
  razorpayKeySecret: '',
  geminiApiKey: '',
  authorizeMode: 'sim',
  llmMode: 'cassette',
  publicBaseUrl: '',
  razorpayWebhookSecret: '',
};

function replaySession(): Session {
  const { provider } = createProvider({
    cassetteDir: CONSOLE_CASSETTE_DIR,
    config: KEYLESS,
    force: 'replay',
  });
  return new Session({
    sessionId: CONSOLE_SESSION_ID,
    buyerId: `buyer_${CONSOLE_SESSION_ID}`,
    mandate: demoMandate(),
    gateKey,
    catalog: CATALOG,
    budget: demoBudget(),
    provider,
    sellingModel: MODELS.sellingAgent,
    classifierModel: MODELS.pressureClassifier,
    merchantName: DEMO_MERCHANT,
  });
}

describe('the console replays its recorded Gemini turns', () => {
  it('has recordings at all', () => {
    const { provider } = createProvider({
      cassetteDir: CONSOLE_CASSETTE_DIR,
      config: KEYLESS,
      force: 'replay',
    });
    expect((provider as unknown as { size: number }).size).toBeGreaterThan(0);
  });

  for (const persona of Object.values(PERSONAS)) {
    it(`replays every turn for ${persona.id}`, async () => {
      const session = replaySession();

      for (const message of consoleTurns(persona)) {
        const result = await session.takeTurn(message);
        expect(result.agentMessage.length).toBeGreaterThan(0);
      }
    });
  }

  it('collapses on the injection, live, from replayed prose', async () => {
    const session = replaySession();
    const result = await session.takeTurn(PERSONAS.prompt_injector.scriptedOpening);

    expect(result.pressure.state).toBe('COLLAPSED');
    expect(result.collapsedThisTurn).toBe(true);
  });

  it('keeps the ratchet shut once the injector turns polite', async () => {
    const session = replaySession();
    let last;
    for (const message of consoleTurns(PERSONAS.prompt_injector)) {
      last = await session.takeTurn(message);
    }

    // The final turn asks an ordinary commercial question. Pressure does not
    // recover because a session went quiet — that is the whole reason the
    // ratchet is one-way.
    expect(last?.pressure.state).toBe('COLLAPSED');
    expect(last?.offer?.depth_pct ?? 0).toBe(0);
  });

  it('still sells to an honest buyer', async () => {
    const session = replaySession();
    for (const message of consoleTurns(PERSONAS.honest_bulk_buyer)) {
      await session.takeTurn(message);
    }

    expect(session.signedOffers.length).toBeGreaterThan(0);
    // Every offer carries a signature the gate produced during THIS run.
    for (const offer of session.signedOffers) {
      expect(offer.signature.sig.length).toBeGreaterThan(0);
    }
  });
});
