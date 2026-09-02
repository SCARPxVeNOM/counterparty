/**
 * Gemini, via the official @google/genai SDK.
 */

import { GoogleGenAI } from '@google/genai';
import {
  LlmError,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
} from './provider';

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    if (apiKey === '') {
      throw new LlmError('GEMINI_API_KEY is not set', 'NO_API_KEY');
    }
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const wantsJson = request.responseSchema !== undefined;

    let response;
    try {
      response = await this.client.models.generateContent({
        model: request.model,
        contents: request.messages.map((message) => ({
          role: message.role,
          parts: [{ text: message.text }],
        })),
        config: {
          ...(request.system === undefined ? {} : { systemInstruction: request.system }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
          ...(wantsJson
            ? { responseMimeType: 'application/json', responseSchema: request.responseSchema as never }
            : {}),
        },
      });
    } catch (cause) {
      const status = statusOf(cause);
      throw new LlmError(
        `Gemini call failed for ${request.label ?? request.model}: ${(cause as Error).message}`,
        'PROVIDER_ERROR',
        status === undefined ? {} : { status },
      );
    }

    const text = response.text ?? '';
    if (text === '') {
      throw new LlmError(explainEmpty(request, response), 'EMPTY_RESPONSE');
    }

    const usage = response.usageMetadata;

    return {
      text,
      ...(wantsJson ? { json: parseJson(text, request.label ?? request.model) } : {}),
      model: request.model,
      ...(usage === undefined
        ? {}
        : {
            usage: {
              inputTokens: usage.promptTokenCount ?? 0,
              outputTokens: usage.candidatesTokenCount ?? 0,
            },
          }),
      fromCassette: false,
    };
  }
}

/**
 * The HTTP status behind a thrown SDK error.
 *
 * The SDK's own `ApiError` carries `status` as a number, which is the easy
 * case. Not every failure arrives as one — some surface as a plain `Error`
 * whose message embeds the response body. Reading the code back out of that
 * text is inelegant; treating a 503 as fatal because it arrived in the wrong
 * wrapper is worse, so the two documented shapes are matched explicitly rather
 * than by scanning the message for any three digits.
 */
function statusOf(cause: unknown): number | undefined {
  const direct = (cause as { status?: unknown } | null)?.status;
  if (typeof direct === 'number') return direct;

  const message = (cause as Error | null)?.message ?? '';
  const match = /got status:\s*(\d{3})/.exec(message) ?? /"code"\s*:\s*(\d{3})/.exec(message);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

interface EmptyDiagnosis {
  readonly candidates?: { readonly finishReason?: unknown }[];
  readonly usageMetadata?: { readonly thoughtsTokenCount?: number };
}

/**
 * Why an empty answer was empty.
 *
 * Gemini 3.x are thinking models: reasoning tokens are drawn from the same
 * output budget as the answer. Set the budget too low and the call returns
 * HTTP 200 with `finishReason=MAX_TOKENS` and no text at all — which reads
 * exactly like a dead API key and is nothing of the sort. That misdiagnosis
 * cost real time here, so the diagnosis is in the error rather than in someone's
 * memory.
 */
function explainEmpty(request: GenerateRequest, response: EmptyDiagnosis): string {
  const label = request.label ?? request.model;
  const finish = response.candidates?.[0]?.finishReason;
  const thoughts = response.usageMetadata?.thoughtsTokenCount ?? 0;

  const because =
    finish === 'MAX_TOKENS'
      ? ` — finishReason=MAX_TOKENS with ${thoughts} thinking tokens spent, so the ` +
        `maxOutputTokens budget (${request.maxOutputTokens ?? 'unset'}) was consumed by reasoning ` +
        `before any answer was emitted. Raise it; the key is fine.`
      : finish === undefined
        ? ''
        : ` (finishReason=${String(finish)})`;

  return `Gemini returned no text for ${label}${because}`;
}

/**
 * Structured output is constrained by the schema, so this should always
 * succeed. When it does not, the raw text goes into the error — a JSON parse
 * failure with the offending payload hidden is the least debuggable error a
 * model integration can produce.
 */
function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new LlmError(
      `${label} returned unparseable JSON (${(cause as Error).message}): ${text.slice(0, 400)}`,
      'BAD_JSON',
    );
  }
}
