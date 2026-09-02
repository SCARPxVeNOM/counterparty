/**
 * Configuration. One place for every knob, so a mode change is one edit.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Gemini model routing.
 *
 * Kept in one object because model ids move faster than anything else in this
 * codebase, and hunting them through prompt files is how a demo ends up running
 * half on a deprecated model.
 *
 * The split matters. The selling agent reasons about a counterparty actively
 * trying to manipulate it, which is the part that needs a capable model. The
 * pressure classifier and the buyer personas are high-volume, low-judgment work
 * — one turn each, structured output — and running them on the same model would
 * multiply cost for no benefit.
 */
export const MODELS = {
  /** Adversarial commercial judgment. Stable and built for agentic multi-step. */
  sellingAgent: 'gemini-3.7-flash',
  /** Available for a harder run; preview, so not the default. */
  sellingAgentStrong: 'gemini-3.1-pro-preview',
  /** Perception only: emits pressure signals, never scores or decides. */
  pressureClassifier: 'gemini-3.5-flash-lite',
  /** Adversarial buyer personas for the demo and scenarios. */
  buyerPersona: 'gemini-3.5-flash-lite',
  /** Catalog extraction from storefront HTML. */
  extractor: 'gemini-3.7-flash',
} as const;

export type ModelRole = keyof typeof MODELS;

/**
 * Where to go when the first choice will not answer.
 *
 * Measured, not guessed. Against this account `gemini-3.7-flash` returns 503 on
 * roughly half of calls at the moment, and `gemini-3.1-pro-preview` returns 429
 * on every key because it is not free-tier. Both are survivable, because which
 * model writes the prose has no bearing on what gets signed — see
 * packages/llm/src/retry.ts for why that is safe here and would not be
 * elsewhere.
 *
 * Ordered strongest-first, so a fallback is a smaller step down than the last.
 */
export const MODEL_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  'gemini-3.7-flash': ['gemini-3.6-flash', 'gemini-3.5-flash'],
  'gemini-3.1-pro-preview': ['gemini-3.7-flash', 'gemini-3.5-flash'],
  'gemini-3.5-flash-lite': ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'],
};

export interface Config {
  readonly razorpayKeyId: string;
  readonly razorpayKeySecret: string;
  readonly geminiApiKey: string;
  /** Swaps ONLY the authorize step. See packages/rails/src/types.ts. */
  readonly authorizeMode: 'live' | 'sim';
  /** `cassette` replays recorded model responses so demos are deterministic. */
  readonly llmMode: 'live' | 'cassette';
  readonly publicBaseUrl: string;
  readonly razorpayWebhookSecret: string;
}

/** Walk up from this file to the repo root, which is where .env lives. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

/**
 * A repo-relative path, resolved absolutely.
 *
 * Exists because a bare relative path means different directories to different
 * callers. Next runs its server with cwd `apps/web`; vitest and the scripts run
 * from the repo root. `'cassettes/console'` therefore named two different
 * folders, and the console silently loaded zero recordings and wrote its own set
 * under `apps/web/` — with no error anywhere, because a cassette miss in live
 * mode is a legitimate reason to call the model. Anything shared between the
 * console and a script goes through here.
 */
export function fromRepoRoot(...segments: readonly string[]): string {
  return join(repoRoot(), ...segments);
}

export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at === -1) continue;
    const key = trimmed.slice(0, at).trim();
    let value = trimmed.slice(at + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

let cached: Config | undefined;

export function loadConfig(options: { readonly reload?: boolean } = {}): Config {
  if (cached !== undefined && options.reload !== true) return cached;

  const envPath = join(repoRoot(), '.env');
  const fromFile = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  // Real environment variables win, so CI and the shell can override the file.
  const read = (key: string, fallback = ''): string => process.env[key] ?? fromFile[key] ?? fallback;

  cached = {
    razorpayKeyId: read('RAZORPAY_KEY_ID'),
    razorpayKeySecret: read('RAZORPAY_KEY_SECRET'),
    geminiApiKey: read('GEMINI_API_KEY'),
    authorizeMode: read('AUTHORIZE_MODE', 'sim') === 'live' ? 'live' : 'sim',
    llmMode: read('LLM_MODE', 'cassette') === 'live' ? 'live' : 'cassette',
    publicBaseUrl: read('PUBLIC_BASE_URL'),
    razorpayWebhookSecret: read('RAZORPAY_WEBHOOK_SECRET'),
  };
  return cached;
}

export interface Readiness {
  readonly razorpay: 'ready' | 'missing' | 'not_test_mode';
  readonly gemini: 'ready' | 'missing';
}

/**
 * What can actually run right now.
 *
 * Reported rather than thrown, so the console and the CLI can degrade to
 * simulated rails and cassette playback with an accurate label instead of
 * refusing to start.
 */
export function readiness(config: Config = loadConfig()): Readiness {
  return {
    razorpay:
      config.razorpayKeyId === '' || config.razorpayKeySecret === ''
        ? 'missing'
        : config.razorpayKeyId.startsWith('rzp_test')
          ? 'ready'
          : 'not_test_mode',
    gemini: config.geminiApiKey === '' ? 'missing' : 'ready',
  };
}

export function describeReadiness(state: Readiness = readiness()): string {
  const razorpay = {
    ready: 'Razorpay test keys present',
    missing: 'Razorpay keys missing — rails will not reach the API',
    not_test_mode: 'REFUSING: these are not test-mode keys',
  }[state.razorpay];
  const gemini = {
    ready: 'Gemini key present',
    missing: 'Gemini key missing — the agent will run from cassettes',
  }[state.gemini];
  return `${razorpay}\n${gemini}`;
}
