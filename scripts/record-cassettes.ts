/**
 * Record the console's model turns against real Gemini.
 *
 *   pnpm record:cassettes
 *
 * WHY THIS SCRIPT EXISTS AT ALL. Until now the console had two modes: a live
 * Gemini key, or a rule-based stand-in. What it did not have was the useful
 * third one — real Gemini prose, replayed deterministically, with no key and no
 * network. That is what a cassette is for, and cassettes only exist if
 * something records them.
 *
 * It drives the SAME `Session` the console constructs, with the same mandate,
 * catalog, budget and models. That is the whole trick: a cassette is keyed by a
 * hash of the request, so a recording only replays if the console produces a
 * byte-identical request. Constructing the session any differently here would
 * produce recordings that quietly never hit.
 *
 * WHAT IS BEING RECORDED, PRECISELY. What the model said. Nothing else. Every
 * gate decision on replay is computed live, against the real envelope, with real
 * Ed25519 signing over the real canonical bytes. A replayed injection genuinely
 * collapses the envelope; a replayed over-ask is genuinely refused, by the same
 * code, citing the same clause. Fixing the model's half of the conversation is
 * the point — it is the only half that is nondeterministic, and the only half
 * the thesis says does not matter.
 *
 * Re-running is cheap. The cassette returns a hit before it reaches the network,
 * so a second run records only what is missing.
 */

import { Session, PERSONAS, type Persona } from '@counterparty/agents';
import { MODELS, loadConfig } from '@counterparty/config';
import { createProvider } from '@counterparty/llm';
import {
  CATALOG,
  CONSOLE_CASSETTE_DIR as CASSETTE_DIR,
  CONSOLE_SESSION_ID as SESSION_ID,
  DEMO_MERCHANT,
  consoleTurns,
  demoBudget,
  demoMandate,
  gateKey,
} from '@counterparty/demo';

function sessionFor(): Session {
  const { provider } = createProvider({ cassetteDir: CASSETTE_DIR, force: 'record' });
  return new Session({
    sessionId: SESSION_ID,
    buyerId: `buyer_${SESSION_ID}`,
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

async function recordPersona(persona: Persona): Promise<void> {
  console.log(`\n${persona.label}${persona.adversarial ? '  [adversarial]' : ''}`);

  const session = sessionFor();

  for (const message of consoleTurns(persona)) {
    const result = await session.takeTurn(message);
    const gate =
      result.offer !== undefined
        ? `signed ${result.offer.depth_pct}% (${result.offer.authorized_by})`
        : result.refusal !== undefined
          ? `refused (${result.refusal.clause})`
          : 'no proposal';

    console.log(`  buyer:  ${message.slice(0, 76)}`);
    console.log(`  agent:  ${result.agentMessage.slice(0, 76)}`);
    console.log(
      `  gate:   ${gate}  |  pressure ${result.pressure.state} ${result.pressure.score.toFixed(2)}`,
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.geminiApiKey === '') {
    console.error(
      'REFUSING: GEMINI_API_KEY is not set in .env.\n' +
        'There is nothing to record from. The console falls back to the scripted\n' +
        'seller without a key, which is a stand-in and is badged as one.',
    );
    process.exit(1);
  }

  console.log(`Recording the console's model turns into ${CASSETTE_DIR}/`);
  console.log(`  selling agent:      ${MODELS.sellingAgent}`);
  console.log(`  pressure classifier: ${MODELS.pressureClassifier}`);

  const failures: string[] = [];
  for (const persona of Object.values(PERSONAS)) {
    try {
      await recordPersona(persona);
    } catch (error) {
      // One persona failing must not lose the recordings the others produced —
      // they are already written to disk turn by turn.
      failures.push(`${persona.id}: ${(error as Error).message}`);
      console.log(`  FAILED — ${(error as Error).message}`);
    }
  }

  const { provider } = createProvider({ cassetteDir: CASSETTE_DIR, force: 'replay' });
  console.log(`\n${(provider as { size?: number }).size ?? '?'} recordings now in ${CASSETTE_DIR}/`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} persona(s) did not complete:`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
