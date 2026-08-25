/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Two JSON documents that differ only in key order or whitespace must produce
 * byte-identical output, or every signature in this system is meaningless. The
 * merchant signs canonical bytes; a verifier we do not control — a buyer agent,
 * a judge running the CLI — must reproduce those exact bytes from the same
 * logical document without having seen our serializer.
 *
 * Implementation notes, in JCS terms:
 *  - Object members are sorted by UTF-16 code unit order. JavaScript's `<` on
 *    strings is already a UTF-16 code unit comparison, which is exactly the
 *    ordering the spec requires.
 *  - Numbers use ECMAScript `Number::toString`, which is what `String(n)` gives.
 *  - Strings use JSON escaping, which `JSON.stringify` on a string produces
 *    with the short escapes (\n, \t, ...) the spec mandates.
 *  - NaN and Infinity are not representable and are rejected rather than
 *    silently becoming null, which is what `JSON.stringify` would do.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export class CanonicalizationError extends Error {
  override readonly name = 'CanonicalizationError';
}

/** Canonical JCS string for a JSON value. */
export function canonicalize(value: JsonValue): string {
  return serialize(value, 0);
}

/** Canonical JCS bytes — what actually gets signed. */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/** Guards against a cyclic or pathologically nested document. */
const MAX_DEPTH = 64;

function serialize(value: JsonValue, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalizationError(`document nested deeper than ${MAX_DEPTH} levels`);
  }

  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalizationError(`value of type ${typeof value} is not JSON`);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (item === undefined) {
        // JSON.stringify turns holes and undefined array members into null.
        // Doing that silently would let two different documents canonicalize
        // identically, so we refuse instead.
        throw new CanonicalizationError('undefined is not permitted in an array');
      }
      return serialize(item, depth + 1);
    });
    return `[${items.join(',')}]`;
  }

  const object = value as JsonObject;
  const keys = Object.keys(object).sort(compareCodeUnits);
  const members: string[] = [];

  for (const key of keys) {
    const member = object[key];
    // An absent member and a member set to undefined are the same document.
    if (member === undefined) continue;
    members.push(`${JSON.stringify(key)}:${serialize(member, depth + 1)}`);
  }

  return `{${members.join(',')}}`;
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalizationError(`${n} is not representable in JSON`);
  }
  // String(-0) is already "0", which is what JCS requires.
  return String(n);
}

/**
 * UTF-16 code unit ordering. Not `localeCompare` — that is locale-dependent and
 * would make canonical output vary by machine, which is the one thing this
 * function exists to prevent.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
