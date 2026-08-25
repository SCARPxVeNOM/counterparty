import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  canonicalBytes,
  CanonicalizationError,
  type JsonObject,
  type JsonValue,
} from '../../src/crypto/canonical';

describe('canonicalize — member ordering', () => {
  it('sorts object members', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('produces identical output regardless of insertion order', () => {
    const a: JsonObject = { zebra: 1, alpha: { nested: true, another: [3, 2, 1] }, m: null };
    const b: JsonObject = { m: null, alpha: { another: [3, 2, 1], nested: true }, zebra: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('does not reorder arrays — position is meaning', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('orders uppercase before lowercase, digits before letters', () => {
    expect(canonicalize({ a: 0, A: 0, '1': 0, _: 0 })).toBe('{"1":0,"A":0,"_":0,"a":0}');
  });

  /**
   * The case that separates a correct JCS implementation from a plausible one.
   *
   * U+1F602 is a non-BMP character stored as the surrogate pair D83D DE02.
   * Sorting by UTF-16 code unit compares D83D, which is LESS than FFFD, so the
   * emoji sorts first. Sorting by code point compares 1F602, which is GREATER
   * than FFFD, so it would sort last. RFC 8785 requires the former.
   */
  it('sorts by UTF-16 code unit, not by code point', () => {
    const result = canonicalize({ '�': 'replacement', '\u{1F602}': 'emoji' });
    expect(result).toBe('{"\u{1F602}":"emoji","�":"replacement"}');
    expect(result.indexOf('emoji')).toBeLessThan(result.indexOf('replacement'));
  });

  it('sorts BMP characters by their code unit value', () => {
    // euro U+20AC, katakana pa U+30D1
    expect(canonicalize({ 'パ': 2, '€': 1 })).toBe('{"€":1,"パ":2}');
  });
});

describe('canonicalize — numbers', () => {
  it('serializes integers without a decimal part', () => {
    expect(canonicalize(1)).toBe('1');
    expect(canonicalize(1.0)).toBe('1');
    expect(canonicalize(-42)).toBe('-42');
  });

  it('normalizes negative zero to zero', () => {
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(-0)).toBe(canonicalize(0));
  });

  it('uses ECMAScript exponential form at the boundaries', () => {
    expect(canonicalize(1e21)).toBe('1e+21');
    expect(canonicalize(1e-7)).toBe('1e-7');
    expect(canonicalize(1e20)).toBe('100000000000000000000');
  });

  it('rejects NaN and Infinity rather than silently emitting null', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(CanonicalizationError);
    expect(() => canonicalize(Number.NEGATIVE_INFINITY)).toThrow(CanonicalizationError);
  });
});

describe('canonicalize — strings', () => {
  it('uses short escapes for the control characters that have them', () => {
    expect(canonicalize('a\nb')).toBe('"a\\nb"');
    expect(canonicalize('a\tb')).toBe('"a\\tb"');
    expect(canonicalize('a\rb')).toBe('"a\\rb"');
  });

  it('escapes quotes and backslashes', () => {
    expect(canonicalize('say "hi"')).toBe('"say \\"hi\\""');
    expect(canonicalize('back\\slash')).toBe('"back\\\\slash"');
  });

  it('escapes other control characters as \\u00xx', () => {
    expect(canonicalize('')).toBe('"\\u0001"');
  });

  it('leaves printable non-ASCII unescaped', () => {
    expect(canonicalize('₹4,990')).toBe('"₹4,990"');
  });
});

describe('canonicalize — absent values', () => {
  it('treats an undefined member as an absent member', () => {
    const withUndefined: JsonObject = { a: 1, b: undefined };
    expect(canonicalize(withUndefined)).toBe('{"a":1}');
    expect(canonicalize(withUndefined)).toBe(canonicalize({ a: 1 }));
  });

  it('preserves explicit null, which is a value and not an absence', () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
  });

  it('refuses undefined inside an array instead of coercing it to null', () => {
    const withHole = [1, undefined, 3] as unknown as JsonValue;
    expect(() => canonicalize(withHole)).toThrow(CanonicalizationError);
  });
});

describe('canonicalize — structure', () => {
  it('emits no whitespace', () => {
    expect(canonicalize({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}');
  });

  it('handles empty containers', () => {
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
  });

  it('rejects a document nested past the depth limit', () => {
    let deep: JsonValue = 'bottom';
    for (let i = 0; i < 70; i += 1) deep = [deep];
    expect(() => canonicalize(deep)).toThrow(CanonicalizationError);
  });

  it('encodes to UTF-8 bytes', () => {
    const bytes = canonicalBytes({ '₹': 1 });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe('{"₹":1}');
  });
});
