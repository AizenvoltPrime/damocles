import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { porterStem } from '../porter-stem';
import { ENGLISH_REFERENCE_WORDS } from '../injection/english-reference.generated';
import { SOFTWARE_REFERENCE_WORDS } from '../injection/software-reference.generated';
import { ENGLISH_REFERENCE_STEMS, SOFTWARE_REFERENCE_STEMS } from '../injection/reference-stems.generated';

/** The term SQLite's `porter unicode61` tokenizer indexes for each single-token input. */
function sqliteStems(words: readonly string[]): string[] {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');`);
    const insert = db.prepare('INSERT INTO t(rowid, x) VALUES (?, ?)');
    db.exec('BEGIN');
    words.forEach((w, i) => insert.run(i + 1, w));
    db.exec('COMMIT');
    const stems = new Array<string>(words.length);
    for (const row of db.prepare('SELECT doc, term FROM v').all() as Array<{ doc: number; term: string }>) {
      stems[row.doc - 1] = row.term;
    }
    return stems;
  } finally {
    db.close();
  }
}

const SUFFIXES = ['', 's', 'es', 'ed', 'ing', 'ly', 'er', 'ness', 'ation', 'ization', 'ability', 'ful', 'ive', 'ity'];

describe('porterStem', () => {
  it('matches the FTS5 porter tokenizer on every reference word and its suffixed forms', () => {
    const reference = `${ENGLISH_REFERENCE_WORDS} ${SOFTWARE_REFERENCE_WORDS}`.split(/\s+/).filter(Boolean);
    const words = [...new Set(reference.flatMap(w => SUFFIXES.map(s => w + s)))];
    const expected = sqliteStems(words);
    const mismatches = words.filter((w, i) => porterStem(w) !== expected[i]).slice(0, 10);
    expect(mismatches.map(w => `${w}: ${porterStem(w)} vs ${expected[words.indexOf(w)]}`)).toEqual([]);
    expect(words.length).toBeGreaterThan(500_000);
  });

  it('agrees with the stems generated for the gate, word for word', () => {
    const words = (list: string): string[] => list.split(/\s+/).filter(Boolean);
    expect(words(ENGLISH_REFERENCE_STEMS)).toEqual(words(ENGLISH_REFERENCE_WORDS).map(porterStem));
    expect(words(SOFTWARE_REFERENCE_STEMS)).toEqual(words(SOFTWARE_REFERENCE_WORDS).map(porterStem));
  });

  it('matches it on identifiers with digits and passes short and long tokens through', () => {
    const words = ['oauth2', 'es2022', 'h264', 'utf8s', 'v2', 'ab', 'x'.repeat(65), `${'a'.repeat(60)}ings`];
    expect(words.map(porterStem)).toEqual(sqliteStems(words));
  });
});
