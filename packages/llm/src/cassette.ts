/**
 * Cassette record and replay.
 *
 * A demo that depends on a live model is a demo that can fail in front of a
 * panel for reasons unrelated to the thing being demonstrated — rate limits, a
 * slow region, a model that phrases something differently on the night. And an
 * adversarial test suite that calls a model is nondeterministic and costs money
 * every run, which in practice means it stops being run.
 *
 * So every model call is keyed by a hash of its request and recorded. Replay is
 * the default; `record` reaches the network and saves what comes back.
 *
 * WHAT THIS DOES NOT WEAKEN. The cassette records what the MODEL said. It does
 * not record what the gate decided — the gate is pure code and re-runs for real
 * on every replay, against the real envelope, with real signature operations.
 * A replayed scenario still genuinely refuses, genuinely signs, and genuinely
 * collapses. What is fixed is only the model's side of the conversation, which
 * is exactly the part a demo needs to be reproducible.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize, type JsonObject } from '@counterparty/core';
import {
  LlmError,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
} from './provider.js';

export type CassetteMode = 'replay' | 'record' | 'passthrough';

interface CassetteEntry {
  readonly key: string;
  readonly label: string;
  readonly model: string;
  /** Stored for a human reading the file; never used for lookup. */
  readonly request_preview: string;
  readonly text: string;
  readonly json?: unknown;
  readonly recorded_at: string;
}

/**
 * The cassette key.
 *
 * Hashes the parts of a request that change the answer: model, system prompt,
 * messages, schema, temperature. Deliberately excludes `label`, which is
 * documentation, so renaming a call site does not invalidate a recording.
 */
export function cassetteKey(request: GenerateRequest): string {
  const material = {
    model: request.model,
    system: request.system ?? '',
    messages: request.messages.map((m) => ({ role: m.role, text: m.text })),
    responseSchema: (request.responseSchema ?? null) as unknown,
    temperature: request.temperature ?? null,
  };
  return createHash('sha256').update(canonicalize(material as unknown as JsonObject)).digest('hex').slice(0, 32);
}

export class CassetteProvider implements LLMProvider {
  readonly name: string;
  private readonly entries = new Map<string, CassetteEntry>();

  constructor(
    private readonly directory: string,
    private readonly mode: CassetteMode,
    private readonly upstream?: LLMProvider,
  ) {
    this.name = `cassette(${mode})`;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.directory)) return;
    for (const file of readdirSync(this.directory)) {
      if (!file.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(readFileSync(join(this.directory, file), 'utf8')) as CassetteEntry;
        this.entries.set(entry.key, entry);
      } catch {
        // A corrupt cassette should degrade to a miss, not crash the process.
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const key = cassetteKey(request);
    const recorded = this.entries.get(key);

    if (recorded !== undefined && this.mode !== 'passthrough') {
      return {
        text: recorded.text,
        ...(recorded.json === undefined ? {} : { json: recorded.json }),
        model: recorded.model,
        fromCassette: true,
      };
    }

    if (this.mode === 'replay') {
      throw new LlmError(
        `no recording for ${request.label ?? request.model} (key ${key}). ` +
          `Run with LLM_MODE=live to record it, or check whether a prompt changed.`,
        'CASSETTE_MISS',
      );
    }

    if (this.upstream === undefined) {
      throw new LlmError(
        `cassette is in ${this.mode} mode but has no upstream provider to record from`,
        'NO_API_KEY',
      );
    }

    const result = await this.upstream.generate(request);
    this.save(key, request, result);
    return result;
  }

  private save(key: string, request: GenerateRequest, result: GenerateResult): void {
    mkdirSync(this.directory, { recursive: true });
    const label = (request.label ?? 'call').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    const entry: CassetteEntry = {
      key,
      label: request.label ?? '',
      model: result.model,
      request_preview: (request.messages.at(-1)?.text ?? '').slice(0, 300),
      text: result.text,
      ...(result.json === undefined ? {} : { json: result.json }),
      recorded_at: new Date().toISOString(),
    };
    this.entries.set(key, entry);
    writeFileSync(
      join(this.directory, `${label}.${key.slice(0, 8)}.json`),
      `${JSON.stringify(entry, null, 2)}\n`,
      'utf8',
    );
  }
}

/**
 * An in-memory cassette for unit tests: hand it the exact responses a test
 * needs, with no filesystem involved.
 */
export class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  private index = 0;

  constructor(private readonly responses: ReadonlyArray<{ text: string; json?: unknown }>) {}

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const next = this.responses[this.index];
    this.index += 1;
    if (next === undefined) {
      throw new LlmError(
        `scripted provider ran out of responses at call ${this.index} (${request.label ?? request.model})`,
        'CASSETTE_MISS',
      );
    }
    return {
      text: next.text,
      ...(next.json === undefined ? {} : { json: next.json }),
      model: request.model,
      fromCassette: true,
    };
  }
}
