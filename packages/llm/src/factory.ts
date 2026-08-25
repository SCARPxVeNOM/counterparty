/**
 * Assembling a provider from configuration.
 *
 * The rule: never fail to start. A missing key degrades to cassette replay with
 * an accurate label, because a demo console that refuses to boot teaches nobody
 * anything, and the deterministic scenarios do not need a key at all.
 */

import { loadConfig, type Config } from '@counterparty/config';
import { CassetteProvider, type CassetteMode } from './cassette.js';
import { GeminiProvider } from './gemini.js';
import { UnavailableProvider, type LLMProvider } from './provider.js';

export interface ProviderChoice {
  readonly provider: LLMProvider;
  readonly mode: CassetteMode | 'live';
  /** One line, suitable for printing in a banner or a console badge. */
  readonly description: string;
}

export function createProvider(options: {
  readonly cassetteDir: string;
  readonly config?: Config;
  /** Force a mode regardless of configuration. Used by the scenario runner. */
  readonly force?: CassetteMode;
}): ProviderChoice {
  const config = options.config ?? loadConfig();
  const hasKey = config.geminiApiKey !== '';

  const upstream: LLMProvider = hasKey
    ? new GeminiProvider(config.geminiApiKey)
    : new UnavailableProvider('GEMINI_API_KEY is not set in .env');

  if (options.force !== undefined) {
    const cassette = new CassetteProvider(options.cassetteDir, options.force, upstream);
    return {
      provider: cassette,
      mode: options.force,
      description: `cassette:${options.force} (${cassette.size} recordings)`,
    };
  }

  if (config.llmMode === 'live' && hasKey) {
    // Live still writes through the cassette, so every real call becomes a
    // recording. Recording is a side effect of running, never a separate chore
    // someone has to remember before a demo.
    const recorder = new CassetteProvider(options.cassetteDir, 'record', upstream);
    return { provider: recorder, mode: 'record', description: 'gemini live (recording to cassette)' };
  }

  const cassette = new CassetteProvider(options.cassetteDir, 'replay', upstream);
  return {
    provider: cassette,
    mode: 'replay',
    description: hasKey
      ? `cassette replay (${cassette.size} recordings; set LLM_MODE=live to call Gemini)`
      : `cassette replay (${cassette.size} recordings; no GEMINI_API_KEY, so live is unavailable)`,
  };
}
