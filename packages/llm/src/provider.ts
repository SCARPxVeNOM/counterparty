/**
 * The model boundary.
 *
 * Everything that talks to a model goes through this interface, for two
 * reasons. The obvious one is that swapping providers should be one file. The
 * one that matters more here: a single choke point is what makes cassette
 * replay possible, and cassette replay is what lets the adversarial scenarios
 * run as tests — deterministically, offline, at zero cost.
 *
 * Note what this interface does NOT have: any notion of a decision. Callers get
 * text or structured JSON back. Nothing in this package decides whether to
 * concede, what a discount should be, or how much pressure a message carries.
 * Those live in packages/core, in pure functions, and that separation is the
 * design's central claim rather than an implementation detail.
 */

export interface LlmMessage {
  readonly role: 'user' | 'model';
  readonly text: string;
}

export interface GenerateRequest {
  readonly model: string;
  readonly system?: string;
  readonly messages: readonly LlmMessage[];
  /**
   * A JSON schema. When present the model is constrained to it and `json` is
   * populated on the result.
   */
  readonly responseSchema?: Record<string, unknown>;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Free-text label so cassette files are readable by a human. */
  readonly label?: string;
}

export interface GenerateResult {
  readonly text: string;
  readonly json?: unknown;
  readonly model: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** True when this came from a recording rather than the network. */
  readonly fromCassette: boolean;
}

export interface LLMProvider {
  readonly name: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

export class LlmError extends Error {
  override readonly name = 'LlmError';
  /**
   * The HTTP status, when the failure came from the API rather than from us.
   *
   * Carried because the difference between 503 and 401 is the difference
   * between "wait a moment" and "your key is wrong", and a caller that only
   * sees a message string has to guess. See retry.ts, which does not guess.
   */
  readonly status?: number;

  constructor(
    message: string,
    readonly code: 'NO_API_KEY' | 'CASSETTE_MISS' | 'BAD_JSON' | 'EMPTY_RESPONSE' | 'PROVIDER_ERROR',
    options: { readonly status?: number } = {},
  ) {
    super(message);
    if (options.status !== undefined) this.status = options.status;
  }
}

/**
 * A provider that refuses to do anything.
 *
 * Used when no key is configured and no cassette covers the call. It exists so
 * the failure is a clear message naming the missing key rather than an
 * undefined dereference three frames deep in an agent.
 */
export class UnavailableProvider implements LLMProvider {
  readonly name = 'unavailable';

  constructor(private readonly why: string) {}

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    throw new LlmError(
      `no model available for ${request.label ?? request.model}: ${this.why}`,
      'NO_API_KEY',
    );
  }
}
