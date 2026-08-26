/**
 * A thin Razorpay HTTP client.
 *
 * Deliberately not the official SDK. The SDK is fine, but this system's whole
 * argument is that every money action is explainable, and a hand-rolled client
 * means the exact request and the exact error code are visible in one file
 * rather than three layers down. It also makes the cassette recorder trivial:
 * one place to intercept.
 *
 * Errors are surfaced with Razorpay's own `code` and `description` intact. A
 * 401 that says "Authentication failed" is far more useful to whoever is
 * debugging than a generic wrapper.
 */

import { RailsError } from './types';

export interface RazorpayCredentials {
  readonly keyId: string;
  readonly keySecret: string;
}

export interface RazorpayClientOptions {
  readonly credentials: RazorpayCredentials;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Called with every request and response, for cassette recording. */
  readonly onExchange?: (exchange: Exchange) => void;
}

export interface Exchange {
  readonly method: string;
  readonly path: string;
  readonly requestBody?: unknown;
  readonly status: number;
  readonly responseBody: unknown;
  readonly durationMs: number;
}

const DEFAULT_BASE = 'https://api.razorpay.com/v1';

export class RazorpayClient {
  /**
   * The public half of the credential pair, deliberately readable.
   *
   * Razorpay Checkout runs in the buyer's browser and needs the key id in the
   * page. That is what a key id is for — it identifies the merchant and
   * authorizes nothing. The secret builds the Basic header below and is never
   * exposed on this class at all, so there is no accessor to reach for by
   * mistake when wiring up a browser payload.
   */
  readonly keyId: string;

  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onExchange: ((exchange: Exchange) => void) | undefined;

  constructor(options: RazorpayClientOptions) {
    const { keyId, keySecret } = options.credentials;
    if (keyId === '' || keySecret === '') {
      throw new RailsError('Razorpay credentials are missing', 'MISSING_CREDENTIALS');
    }
    this.keyId = keyId;
    this.authHeader = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onExchange = options.onExchange;
  }

  /** True when the key is a test-mode key. The console refuses to run against live keys. */
  static isTestKey(keyId: string): boolean {
    return keyId.startsWith('rzp_test');
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const startedAt = Date.now();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        'User-Agent': 'counterparty/0.1',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? {} : JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }

    this.onExchange?.({
      method,
      path,
      ...(body === undefined ? {} : { requestBody: body }),
      status: response.status,
      responseBody: parsed,
      durationMs: Date.now() - startedAt,
    });

    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; description?: string } }).error;
      throw new RailsError(
        error?.description ?? `Razorpay returned ${response.status} for ${method} ${path}`,
        error?.code ?? 'HTTP_ERROR',
        response.status,
      );
    }

    return parsed as T;
  }
}

/** Shapes Razorpay actually returns, narrowed to what this system reads. */
export interface RawOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt: string | null;
}

export interface RawPayment {
  id: string;
  order_id: string | null;
  amount: number;
  status: string;
  method: string;
  captured: boolean;
  created_at: number;
}

export interface RawRefund {
  id: string;
  payment_id: string;
  amount: number;
  speed_processed?: string;
  speed_requested?: string;
}

export interface RawPaymentLink {
  id: string;
  short_url: string;
  amount: number;
  status: string;
}

export interface RawOffer {
  id: string;
  name: string;
  value: number;
}

export interface RawSubscription {
  id: string;
  plan_id: string;
  status: string;
}

export interface RawList<T> {
  count: number;
  items: T[];
}
