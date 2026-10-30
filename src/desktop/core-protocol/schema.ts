// Parsers for the core protocol: each returns a fresh value holding only the fields it knows, or INVALID.
import { parseLocalizedText, type LocalizedText } from '../../shared/localized-text';

export const INVALID: unique symbol = Symbol('invalid');
export type Invalid = typeof INVALID;

export type Parser<T> = (raw: unknown) => T | Invalid;

export interface OptionalParser<T> extends Parser<T | undefined> {
  readonly optional: true;
}

export type Parsed<P> = P extends Parser<infer T> ? T : never;

type Shape = Record<string, Parser<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends OptionalParser<unknown> ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Flat<T> = { [K in keyof T]: T[K] };
export type ParsedShape<S extends Shape> = Flat<
  { readonly [K in RequiredKeys<S>]: Parsed<S[K]> } & { readonly [K in OptionalKeys<S>]?: Exclude<Parsed<S[K]>, undefined> }
>;

function record(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

export const str = (max: number): Parser<string> => (raw) => (typeof raw === 'string' && raw.length <= max ? raw : INVALID);

export const nonEmpty = (max: number): Parser<string> => (raw) => (typeof raw === 'string' && raw.length > 0 && raw.length <= max ? raw : INVALID);

export const num: Parser<number> = (raw) => (typeof raw === 'number' ? raw : INVALID);

export const bool: Parser<boolean> = (raw) => (typeof raw === 'boolean' ? raw : INVALID);

export const int = (min: number, max: number): Parser<number> => (raw) =>
  typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : INVALID;

// A Buffer arrives as a Uint8Array: structured cloning keeps the bytes, not the subclass.
export const bytes = (maxBytes: number): Parser<Uint8Array> => (raw) => (raw instanceof Uint8Array && raw.byteLength <= maxBytes ? raw : INVALID);

export const none: Parser<undefined> = (raw) => (raw === undefined ? undefined : INVALID);

export function oneOf<const T extends readonly string[]>(values: T): Parser<T[number]> {
  return (raw) => (typeof raw === 'string' && values.includes(raw) ? (raw as T[number]) : INVALID);
}

/** A field that may be absent, typed as optional. */
export function opt<T>(parser: Parser<T>): OptionalParser<T> {
  return Object.assign(maybe(parser), { optional: true as const });
}

/** A field that may be absent, typed as present with undefined (`filePath: string | undefined`). */
export function maybe<T>(parser: Parser<T>): Parser<T | undefined> {
  return (raw) => (raw === undefined ? undefined : parser(raw));
}

export function arr<T>(parser: Parser<T>, maxItems: number): Parser<readonly T[]> {
  return (raw) => {
    if (!Array.isArray(raw) || raw.length > maxItems) return INVALID;
    const out: T[] = [];
    for (const item of raw as unknown[]) {
      const parsed = parser(item);
      if (parsed === INVALID) return INVALID;
      out.push(parsed);
    }
    return out;
  };
}

export function dict<T>(parser: Parser<T>, maxKeyChars: number, maxKeys: number): Parser<Readonly<Record<string, T>>> {
  return (raw) => {
    const value = record(raw);
    if (!value) return INVALID;
    const entries = Object.entries(value);
    if (entries.length > maxKeys) return INVALID;
    const out: Record<string, T> = Object.create(null) as Record<string, T>;
    for (const [key, entry] of entries) {
      const parsed = parser(entry);
      if (key.length > maxKeyChars || parsed === INVALID) return INVALID;
      out[key] = parsed;
    }
    return out;
  };
}

export function obj<S extends Shape>(shape: S): Parser<ParsedShape<S>> {
  return (raw) => {
    const value = record(raw);
    if (!value) return INVALID;
    const out: Record<string, unknown> = {};
    for (const [key, parser] of Object.entries(shape)) {
      const parsed = parser(Object.hasOwn(value, key) ? value[key] : undefined);
      if (parsed === INVALID) return INVALID;
      // an absent optional field stays absent, as exactOptionalPropertyTypes reads it
      if (parsed !== undefined) out[key] = parsed;
    }
    return out as ParsedShape<S>;
  };
}

/** A LocalizedText whose every string is within maxChars (parseLocalizedText). */
export function localized(maxChars: number): Parser<LocalizedText> {
  return (raw) => parseLocalizedText(raw, maxChars) ?? INVALID;
}

export function either<A, B>(first: Parser<A>, second: Parser<B>): Parser<A | B> {
  return (raw) => {
    const parsed = first(raw);
    return parsed === INVALID ? second(raw) : parsed;
  };
}

/**
 * JSON-shaped data (plain objects, arrays, strings, numbers, booleans, null and undefined) plus binary (an ArrayBuffer or a view
 * of one: a browser page's frames) of at most maxChars, counting every string, key and byte; anything else, a cycle included,
 * is INVALID. The value is passed through, not copied.
 */
export function data(maxChars: number): Parser<unknown> {
  return (raw) => (dataSize(raw, maxChars, new Set()) <= maxChars ? raw : INVALID);
}

function dataSize(value: unknown, budget: number, ancestors: Set<object>): number {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return 1;
  if (typeof value === 'string') return value.length + 1;
  if (typeof value !== 'object' || ancestors.has(value)) return Infinity;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength + 1;
  const proto: unknown = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (!isArray && proto !== Object.prototype && proto !== null) return Infinity;
  ancestors.add(value);
  let size = 1;
  for (const [key, entry] of Object.entries(value)) {
    size += (isArray ? 0 : key.length) + dataSize(entry, budget - size, ancestors);
    if (size > budget) break;
  }
  ancestors.delete(value);
  return size;
}
