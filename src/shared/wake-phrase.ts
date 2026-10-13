/**
 * The `damocles.voice.wakeWord` phrase. The voice sidecar applies the same rules in wake_phrase.py; both sides are
 * checked against python/damocles_voice_sidecar/tests/fixtures/wake_prefix_cases.json and wake_prefix_corpus.json.
 */

import { WORD_CHAR_RANGES } from "./generated/word-chars";

export const DEFAULT_WAKE_PHRASE = "hey jarvis";

export const WAKE_PHRASE_MAX_WORDS = 4;

/** Must equal the `pattern` package.json declares for `damocles.voice.wakeWord`. */
export const WAKE_PHRASE_SETTING_PATTERN = "^[\\s_]*[A-Za-z]+([\\s_]+[A-Za-z]+){0,3}[\\s_]*$";

export function normalizeWakePhrase(setting: string): string {
  return setting.replace(/_/g, " ").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The phrase's words, or null when the setting is not 1 to 4 words of letters. */
export function parseWakePhrase(setting: string): string[] | null {
  const phrase = normalizeWakePhrase(setting);
  if (phrase === "") return null;
  const words = phrase.split(" ");
  if (words.length > WAKE_PHRASE_MAX_WORDS || !words.every((word) => /^[a-z]+$/.test(word))) return null;
  return words;
}

// Unicode White_Space as a class body; the sidecar's wake_phrase.py uses this text verbatim, never \s.
export const WHITESPACE = "\\t-\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

export const WORD_CHAR_CLASS: string = `[${WORD_CHAR_RANGES.split(" ")
  .map((token) => token.split("-").map((bound) => `\\u{${bound}}`).join("-"))
  .join("")}]`;

const TRIM = new RegExp(`^[${WHITESPACE}]+|[${WHITESPACE}]+$`, "gu");

// Explicit case classes, never the i flag, so only ASCII letters match.
function letters(word: string): string {
  return [...word].map((letter) => `[${letter.toUpperCase()}${letter}]`).join("");
}

/** Matches the phrase, or its last word alone, at the start, when the last word is not followed by a word character. */
export function wakePrefixPattern(words: readonly string[]): RegExp {
  const last = letters(words[words.length - 1]!);
  const lead = words.slice(0, -1);
  const optionalLead = lead.length === 0 ? "" : `(${lead.map((word) => `${letters(word)}[${WHITESPACE}]+`).join("")})?`;
  return new RegExp(`^[${WHITESPACE}]*${optionalLead}${last}(?!${WORD_CHAR_CLASS})[,.${WHITESPACE}]*`, "u");
}

export function stripWakePrefix(text: string, words: readonly string[]): string {
  return text.replace(wakePrefixPattern(words), "").replace(TRIM, "");
}
