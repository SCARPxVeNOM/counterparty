/**
 * Gemini, via the official @google/genai SDK.
 */

import { GoogleGenAI } from '@google/genai';
import {
  LlmError,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
} from './provider.js';

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
      throw new LlmError(
        `Gemini call failed for ${request.label ?? request.model}: ${(cause as Error).message}`,
        'PROVIDER_ERROR',
      );
    }

    const text = response.text ?? '';
    if (text === '') {
      throw new LlmError(
        `Gemini returned no text for ${request.label ?? request.model}`,
        'EMPTY_RESPONSE',
      );
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
