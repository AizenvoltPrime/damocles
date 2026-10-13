import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORD_CHAR_RANGES } from "../../../shared/generated/word-chars";
import {
  DEFAULT_WAKE_PHRASE,
  normalizeWakePhrase,
  parseWakePhrase,
  stripWakePrefix,
  wakePrefixPattern,
  WAKE_PHRASE_SETTING_PATTERN,
  WHITESPACE,
  WORD_CHAR_CLASS,
} from "../../../shared/wake-phrase";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SIDECAR_ROOT = join(REPO_ROOT, "python", "damocles_voice_sidecar");

type WakePrefixFixture = {
  cases: {
    setting: string;
    phrase: string;
    strips: { text: string; expected: string }[];
  }[];
  invalid: string[];
};

type WakePrefixCorpus = { cases: Record<string, [text: string, expected: string][]> };

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(SIDECAR_ROOT, ...segments), "utf8")) as T;
}

// The sidecar's tests read the same files, so a rule changed on one side alone fails one of the two suites.
const fixture = readJson<WakePrefixFixture>("tests", "fixtures", "wake_prefix_cases.json");
const corpus = readJson<WakePrefixCorpus>("tests", "fixtures", "wake_prefix_corpus.json");

type WakeWordSchema = { default: string; pattern: string; scope: string };

function wakeWordSchema(): WakeWordSchema {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    contributes: { configuration: { properties: Record<string, WakeWordSchema> } };
  };
  return manifest.contributes.configuration.properties["damocles.voice.wakeWord"]!;
}

describe("wake phrase rules shared with the sidecar", () => {
  describe.each(fixture.cases)("setting $setting", ({ setting, phrase, strips }) => {
    it("normalizes to the listed phrase", () => {
      expect(normalizeWakePhrase(setting)).toBe(phrase);
      expect(parseWakePhrase(setting)).toEqual(phrase.split(" "));
    });

    it.each(strips)("strips $text", ({ text, expected }) => {
      expect(stripWakePrefix(text, parseWakePhrase(setting)!)).toBe(expected);
    });
  });

  it.each(fixture.invalid)("rejects %j", (setting) => {
    expect(parseWakePhrase(setting)).toBeNull();
  });

  it.each(Object.entries(corpus.cases))("strips the generated corpus for %j as the sidecar does", (phrase, cases) => {
    const words = phrase.split(" ");
    const mismatches = cases
      .map(([text, expected]) => ({ text, expected, actual: stripWakePrefix(text, words) }))
      .filter(({ expected, actual }) => actual !== expected);
    expect(cases.length).toBeGreaterThan(1000);
    expect(mismatches).toEqual([]);
  });
});

describe("wake prefix pattern", () => {
  it("is built from explicit classes with the u flag only", () => {
    // The sidecar's test expects the same text with its own spelling of the word-character class.
    const re = wakePrefixPattern(["hey", "jarvis"]);
    expect(re.flags).toBe("u");
    expect(re.source).toBe(
      String.raw`^[\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*` +
        String.raw`([Hh][Ee][Yy][\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+)?` +
        String.raw`[Jj][Aa][Rr][Vv][Ii][Ss]` +
        `(?!${WORD_CHAR_CLASS})` +
        String.raw`[,.\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*`,
    );
  });

  it("treats exactly Unicode White_Space as whitespace", () => {
    const re = new RegExp(`^[${WHITESPACE}]$`, "u");
    const members: number[] = [];
    for (let code = 0; code <= 0x10ffff; code++) if (re.test(String.fromCodePoint(code))) members.push(code);
    expect(members).toEqual([
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
      0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
    ]);
  });

  it("uses the sidecar's word-character table", () => {
    const python = readFileSync(join(SIDECAR_ROOT, "damocles_voice_sidecar", "word_chars.py"), "utf8");
    const pythonRanges = [...python.matchAll(/^ {4}"([^"]*)"/gm)].map((match) => match[1]).join("");
    expect(pythonRanges).toBe(WORD_CHAR_RANGES);
  });
});

describe("damocles.voice.wakeWord schema", () => {
  const schema = wakeWordSchema();

  it("defaults to the default phrase and stays machine-scoped", () => {
    expect(schema.default).toBe(DEFAULT_WAKE_PHRASE);
    expect(schema.scope).toBe("machine");
  });

  it("declares the pattern the helper validates", () => {
    expect(schema.pattern).toBe(WAKE_PHRASE_SETTING_PATTERN);
    const re = new RegExp(schema.pattern);
    for (const { setting } of fixture.cases) expect(re.test(setting)).toBe(true);
    for (const setting of fixture.invalid) expect(re.test(setting)).toBe(false);
  });
});
