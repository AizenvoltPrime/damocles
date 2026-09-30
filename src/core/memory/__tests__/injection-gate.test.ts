import { describe, it, expect } from 'vitest';
import {
  BUDGETS,
  DEFAULT_TIER_LIMITS,
  GATE,
  analyzeTerms,
  assignTiers,
  commonDfThreshold,
  compareRank,
  evaluateLexical,
  fileProximityMatcher,
  inverseDocumentFrequency,
  normalizeFileFields,
  rareDfThreshold,
  scoreGatedEntry,
  splitTypedPaths,
  vocabularyRank,
  type FileFields,
  type TierCandidate,
} from '../injection/gate';
import { SCORE_WEIGHTS } from '@shared/memory-score';
import { queryTerms, stripEnglishClitics } from '../text-tokenize';

// Calibrated on the replay harness (injection-replay.test.ts) against the real store; a change here
// must be re-validated there (≥70% byte reduction, p95 < 50 ms) before these pins move.
describe('pinned constants', () => {
  it('pins the gate constants', () => {
    expect(GATE).toEqual({
      commonDfMin: 20,
      commonDfFraction: 0.05,
      coreVocabularyRank: 1000,
      rareDfMin: 3,
      rareDfFraction: 0.005,
      identifierMinLength: 3,
      languageMinWords: 3,
      distinctiveMinRelevance: 0.1,
      coverageTerms: 3,
      coverageMinTerms: 2,
      coverageMinRelevance: 0.5,
      fullMinRelevance: 0.4,
    });
  });

  it('pins score weights, budgets and tier defaults', () => {
    expect(SCORE_WEIGHTS).toEqual({ relevance: 0.55, file: 0.15, recency: 0.15, retrieval: 0.1 });
    expect(BUDGETS).toEqual({ sessionTokens: 500, preferenceTokens: 600, preferenceChars: 400, noticeTokens: 600, maxNotices: 10 });
    expect(DEFAULT_TIER_LIMITS).toEqual({ full: 4, compact: 8, tokenBudget: 2000 });
  });
});

describe('term statistics', () => {
  it('derives the common and rare thresholds from the store size', () => {
    expect(commonDfThreshold(100)).toBe(20);
    expect(commonDfThreshold(2000)).toBe(100);
    expect(rareDfThreshold(100)).toBe(3);
    expect(rareDfThreshold(1809)).toBe(10);
    expect(inverseDocumentFrequency(100, 10)).toBeCloseTo(Math.log(11), 10);
  });

  it('ranks general English words and leaves identifiers and names unlisted', () => {
    expect(vocabularyRank('the')).toBe(1);
    expect(vocabularyRank('between')).toBeGreaterThan(0);
    expect(vocabularyRank('between')).toBeLessThanOrEqual(GATE.coreVocabularyRank);
    expect(vocabularyRank('summarize')).toBeGreaterThan(GATE.coreVocabularyRank);
    for (const token of ['baroulkos', 'organizationscope', 'vitest', 'esbuild']) expect(vocabularyRank(token)).toBe(0);
  });

  it('ranks software and conversational words as general vocabulary', () => {
    for (const word of ['repo', 'php', 'api', 'json', 'config', 'hmm', 'yep', 'nope', 'ok', 'readme', 'regex', 'localhost']) {
      expect(vocabularyRank(word), word).toBeGreaterThan(GATE.coreVocabularyRank);
    }
  });

  it('ranks a derived form with the most frequent word sharing its Porter stem', () => {
    expect(vocabularyRank('summarization')).toBe(vocabularyRank('summarize'));
    expect(vocabularyRank('summarization')).toBeGreaterThan(0);
    expect(vocabularyRank('repos')).toBe(vocabularyRank('repo'));
    expect(vocabularyRank('observations')).toBe(vocabularyRank('observed'));
  });

  it('drops store-common and core-vocabulary terms, sets aside unmatched ones, and flags distinctive terms', () => {
    const df = new Map([
      ['vitest', 2],
      ['patchright', 30],
      ['session', 500],
      ['better', 1],
      ['extension', 4],
      ['4050', 1],
    ]);
    const a = analyzeTerms(['vitest', 'patchright', 'session', 'better', 'extension', 'nowhere', '4050'], df, 1000);
    expect(a.common).toEqual(['session', 'better']);
    expect(a.unmatched).toEqual(['nowhere']);
    expect(a.usable.map(t => [t.term, t.distinctive, t.topical])).toEqual([
      ['vitest', true, true],
      ['patchright', true, true],
      ['extension', false, true],
      ['4050', false, false],
    ]);
    expect(a.queryIdf).toBeCloseTo(a.usable.reduce((s, t) => s + t.idf, 0), 10);
  });

  it('keeps the in-store rarity rule for tokens outside the reference alphabet', () => {
    const df = new Map([['μνήμη', 2], ['ρύθμιση', 40]]);
    const a = analyzeTerms(['μνήμη', 'ρύθμιση'], df, 1000);
    expect(a.usable.map(t => [t.term, t.distinctive])).toEqual([
      ['μνήμη', true],
      ['ρύθμιση', false],
    ]);
  });

  it('treats a store-rare identifier of letters and digits as distinctive, in any script', () => {
    const df = new Map([['oauth2', 2], ['es2022', 3], ['h264', 1], ['τ42', 2], ['utf8', 40]]);
    const a = analyzeTerms(['oauth2', 'es2022', 'h264', 'τ42', 'utf8'], df, 1000);
    expect(a.usable.map(t => [t.term, t.distinctive, t.topical])).toEqual([
      ['oauth2', true, true],
      ['es2022', true, true],
      ['h264', true, true],
      ['τ42', true, true],
      ['utf8', false, true],
    ]);
  });

  it('never passes a rule on numbers, digit-led pieces or two-character mixes', () => {
    const terms = ['2026', '26t18', '440z', 's3', 'v2'];
    const a = analyzeTerms(terms, new Map(terms.map(t => [t, 1])), 1000);
    expect(a.usable.map(t => [t.term, t.distinctive, t.topical])).toEqual(terms.map(t => [t, false, false]));
  });

  it('requires store rarity of unlisted words when most of the prompt misses the English reference', () => {
    const n = 1000;
    const german = ['warum', 'schlägt', 'fehl', 'datei', 'konfiguration', 'fehler'];
    const df = new Map([['datei', 2], ['fehler', 30], ['konfiguration', 12]]);
    const a = analyzeTerms(german, df, n);
    expect(a.usable.map(t => [t.term, t.distinctive])).toEqual([
      ['datei', true],
      ['konfiguration', false],
      ['fehler', false],
    ]);
    expect(evaluateLexical(new Set(['fehler']), a).passed).toBe(false);

    const english = analyzeTerms(['why', 'fehler', 'appears', 'build'], df, n);
    expect(english.usable.find(t => t.term === 'fehler')?.distinctive).toBe(true);
  });

  it('never judges a prompt of one or two words not English', () => {
    const df = new Map([['vitest', 30], ['esbuild', 30]]);
    expect(analyzeTerms(['vitest', 'esbuild'], df, 1000).usable.every(t => t.distinctive)).toBe(true);
  });

  it('judges a prompt in another script by its words, so an English name in it must be store-rare', () => {
    const df = new Map([['vitest', 30], ['patchright', 2]]);
    const greek = analyzeTerms(['πώς', 'ρυθμίζω', 'το', 'vitest', 'στο', 'patchright'], df, 1000);
    expect(greek.usable.map(t => [t.term, t.distinctive])).toEqual([
      ['vitest', false],
      ['patchright', true],
    ]);
    const english = analyzeTerms(['configure', 'vitest', 'with', 'patchright'], df, 1000);
    expect(english.usable.map(t => [t.term, t.distinctive])).toEqual([
      ['vitest', true],
      ['patchright', true],
    ]);
  });

  it('counts terms sharing a Porter stem once, since they run the same match', () => {
    const df = new Map([['steering', 40], ['steer', 40], ['steers', 40], ['woken', 4]]);
    const a = analyzeTerms(['steering', 'steer', 'steers', 'woken'], df, 1000);
    expect(a.usable.map(t => t.term)).toEqual(['steering', 'woken']);
  });
});

describe('evaluateLexical', () => {
  const n = 1000;

  it('passes a distinctive-term hit that carries enough of the query, and allows it full', () => {
    const a = analyzeTerms(['undervolt', 'solution'], new Map([['undervolt', 2], ['solution', 60]]), n);
    const hit = evaluateLexical(new Set(['undervolt']), a);
    expect(hit.passed).toBe(true);
    expect(hit.fullAllowed).toBe(true);
    expect(hit.matchedTerms).toEqual(['undervolt']);
  });

  it('allows a distinctive-term hit full only at fullMinRelevance', () => {
    const a = analyzeTerms(['undervolt', 'bundle', 'extension'], new Map([['undervolt', 20], ['bundle', 2], ['extension', 2]]), n);
    const hit = evaluateLexical(new Set(['undervolt']), a);
    expect(hit.relevance).toBeLessThan(GATE.fullMinRelevance);
    expect(hit.passed).toBe(true);
    expect(hit.fullAllowed).toBe(false);
  });

  it('rejects a distinctive-term hit below distinctiveMinRelevance', () => {
    const terms = ['ctor', ...Array.from({ length: 30 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${i}`)];
    const df = new Map(terms.map(t => [t, t === 'ctor' ? 2 : 3]));
    const a = analyzeTerms(terms, df, n);
    const hit = evaluateLexical(new Set(['ctor']), a);
    expect(hit.relevance).toBeLessThan(GATE.distinctiveMinRelevance);
    expect(hit.passed).toBe(false);
  });

  it('passes coverage only on two topical terms, and renders it compact', () => {
    const a = analyzeTerms(['bundle', 'esbuild', 'extension'], new Map([['bundle', 40], ['esbuild', 60], ['extension', 45]]), n);
    const both = evaluateLexical(new Set(['bundle', 'extension']), a);
    expect(both.passed).toBe(true);
    expect(both.relevance).toBe(1);
    expect(both.fullAllowed).toBe(false);
    expect(evaluateLexical(new Set(['bundle']), a).passed).toBe(false);
  });

  it('requires every topical term of a short prompt, and coverageTerms of a longer one', () => {
    const three = analyzeTerms(['bundle', 'extension', 'panel'], new Map([['bundle', 40], ['extension', 40], ['panel', 40]]), n);
    expect(evaluateLexical(new Set(['bundle', 'extension']), three).passed).toBe(false);
    expect(evaluateLexical(new Set(['bundle', 'extension', 'panel']), three).passed).toBe(true);

    const terms = ['bundle', 'extension', 'panel', 'layout', 'theme'];
    const five = analyzeTerms(terms, new Map(terms.map(t => [t, 40])), n);
    expect(evaluateLexical(new Set(['bundle', 'extension']), five).passed).toBe(false);
    expect(evaluateLexical(new Set(['bundle', 'extension', 'panel']), five).passed).toBe(true);
  });

  it('fails coverage below the coverage relevance floor', () => {
    const terms = ['bundle', 'extension', 'scroll', 'panel', 'layout', 'theme', 'button', 'margin', 'cursor', 'border', 'canvas'];
    const a = analyzeTerms(terms, new Map(terms.map(t => [t, 40])), n);
    expect(a.usable.every(t => !t.distinctive)).toBe(true);
    const hit = evaluateLexical(new Set(['bundle', 'extension', 'scroll', 'panel']), a);
    expect(hit.relevance).toBeLessThan(GATE.coverageMinRelevance);
    expect(hit.passed).toBe(false);
  });

  it('never counts numeric terms toward coverage', () => {
    const a = analyzeTerms(['2026', '09', 'bundle'], new Map([['2026', 40], ['09', 40], ['bundle', 40]]), n);
    const hit = evaluateLexical(new Set(['2026', '09', 'bundle']), a);
    expect(hit.relevance).toBe(1);
    expect(hit.passed).toBe(false);
  });

  it('never admits on a lone general word, even as a one-word prompt', () => {
    const one = analyzeTerms(['bundle'], new Map([['bundle', 4]]), n);
    expect(one.usable.map(t => [t.term, t.distinctive])).toEqual([['bundle', false]]);
    expect(evaluateLexical(new Set(['bundle']), one).passed).toBe(false);
  });

  // A store-rare English word alone must not admit an unrelated memory.
  describe('general English words found in real prompts', () => {
    const storeN = 630;
    const lowDf = (terms: string[]): Map<string, number> => new Map(terms.map(t => [t, 2]));

    it('drops core-vocabulary words such as else and between as common', () => {
      const a = analyzeTerms(['anything', 'else', 'baroulkos'], new Map([...lowDf(['anything', 'else']), ['baroulkos', 15]]), storeN);
      expect(a.common).toEqual(['anything', 'else']);
      expect(evaluateLexical(new Set(['else']), a).passed).toBe(false);
    });

    it('does not admit on drop, summarize, remind, insight or watch alone', () => {
      for (const word of ['drop', 'summarize', 'remind', 'insight', 'watch']) {
        const a = analyzeTerms([word, 'sentence'], lowDf([word, 'sentence']), storeN);
        expect(a.usable.find(t => t.term === word)?.distinctive).toBe(false);
        expect(evaluateLexical(new Set([word]), a).passed).toBe(false);
      }
    });

    it('admits only memories matching the distinctive name of a question about a named server', () => {
      const terms = ['memory', 'baroulkos', 'server', 'drop', 'tools', 'between', 'turns'];
      const df = new Map([['memory', 10], ['baroulkos', 15], ['server', 80], ['drop', 5], ['tools', 90], ['between', 9], ['turns', 6]]);
      const a = analyzeTerms(terms, df, storeN);
      expect(evaluateLexical(new Set(['drop', 'between']), a).passed).toBe(false);
      expect(evaluateLexical(new Set(['memory', 'drop', 'turns']), a).passed).toBe(false);
      expect(evaluateLexical(new Set(['baroulkos']), a).passed).toBe(true);
    });

    it('admits a memory on a distinctive name that is frequent but not common in the store', () => {
      const terms = ['remind', 'baroulkos', 'disconnection', 'issue'];
      const df = new Map([['remind', 1], ['baroulkos', 15], ['disconnection', 4], ['issue', 40]]);
      const a = analyzeTerms(terms, df, 2000);
      expect(a.usable.find(t => t.term === 'baroulkos')?.distinctive).toBe(true);
      expect(evaluateLexical(new Set(['baroulkos']), a).passed).toBe(true);
    });

    it('does not admit on a derived, software or conversational word alone', () => {
      for (const word of ['summarization', 'repos', 'php', 'json', 'hmm', 'yep', 'nope', 'ok']) {
        const a = analyzeTerms([word, 'sentence'], lowDf([word, 'sentence']), storeN);
        expect(a.usable.find(t => t.term === word)?.distinctive, word).toBe(false);
        expect(evaluateLexical(new Set([word]), a).passed, word).toBe(false);
      }
    });
  });

  // Prompts and df values recorded by a live 485-memory store, where common starts above df 24.
  describe('prompts recorded by a live store', () => {
    const storeN = 485;
    const analyze = (prompt: string, df: Record<string, number>, n = storeN) => {
      const { terms } = queryTerms(stripEnglishClitics(splitTypedPaths(prompt).text));
      return analyzeTerms(terms, new Map(Object.entries(df)), n);
    };

    it('admits nothing on repo alone', () => {
      const a = analyze('read the 3 biggest files on this repo and tell me what they do no subagents', {
        read: 60, biggest: 2, files: 90, repo: 16, tell: 12, subagents: 40,
      });
      expect(a.usable.map(t => t.term)).toContain('repo');
      expect(a.usable.some(t => t.distinctive)).toBe(false);
      expect(evaluateLexical(new Set(['repo']), a).passed).toBe(false);
    });

    it('takes the name of a bare file name as a term and never its extension', () => {
      const a = analyze(
        'Use SaveObservation to record that OrganizationScope.php scopes Eloquent queries by organization. List the full path of the files.',
        { organizationscope: 3, php: 8, scopes: 13, eloquent: 4, queries: 20, organization: 30, list: 40, full: 60, path: 50, files: 90 },
      );
      expect(a.usable.map(t => t.term)).not.toContain('php');
      expect(a.usable.find(t => t.term === 'organizationscope')?.distinctive).toBe(true);
      expect(evaluateLexical(new Set(['organizationscope']), a).passed).toBe(true);
      expect(evaluateLexical(new Set(['organizationscope', 'eloquent']), a).fullAllowed).toBe(true);
      expect(evaluateLexical(new Set(['eloquent', 'queries']), a).passed).toBe(false);

      const php = analyze('why is php slow here', { php: 8, slow: 6 });
      expect(php.usable.find(t => t.term === 'php')?.distinctive).toBe(false);
      expect(evaluateLexical(new Set(['php']), php).passed).toBe(false);
    });

    it('still admits on baroulkos alone', () => {
      const a = analyze('from memory only: anything else about baroulkos?', { memory: 14, only: 200, anything: 30, baroulkos: 6 });
      expect(a.usable.find(t => t.term === 'baroulkos')?.distinctive).toBe(true);
      const hit = evaluateLexical(new Set(['baroulkos']), a);
      expect(hit.passed).toBe(true);
      expect(hit.fullAllowed).toBe(true);
    });

    it('admits no full memory on two ordinary words from a forget request', () => {
      const a = analyze('Forget the two observations you just saved, and memory 3c85e5e0-50d0-4ab9-8119-7d069cc6c968.', {
        forget: 5, observations: 30, saved: 8, memory: 14,
      });
      expect(a.usable.some(t => t.distinctive)).toBe(false);
      for (const pair of [['forget', 'memory'], ['observations', 'saved']]) {
        const hit = evaluateLexical(new Set(pair), a);
        expect(hit.passed, pair.join()).toBe(false);
        expect(hit.fullAllowed, pair.join()).toBe(false);
      }
    });

    it('admits no memory on save and disk from a prompt about another program', () => {
      const a = analyze(
        'I pressed save disk on afterburnerer and clicked 1 did I do good',
        { pressed: 20, save: 42, disk: 63, clicked: 35, good: 300 },
        1401,
      );
      expect(evaluateLexical(new Set(['save', 'disk']), a).passed).toBe(false);
      const all = evaluateLexical(new Set(['save', 'disk', 'clicked']), a);
      expect(all.passed).toBe(true);
      expect(all.fullAllowed).toBe(false);
    });

    it('adds no term from the username in a typed path', () => {
      const a = analyze(
        'Use SaveObservation to record that C:\\Users\\astefanopoulos\\.claude\\CLAUDE.md holds global agent rules',
        { astefanopoulos: 1, users: 30, claude: 20, md: 40, holds: 3, global: 20, agent: 60, rules: 40 },
      );
      expect([...a.usable.map(t => t.term), ...a.common, ...a.unmatched]).not.toContain('astefanopoulos');
      expect(a.usable.some(t => t.distinctive)).toBe(false);
    });
  });
});

describe('splitTypedPaths', () => {
  it('finds tokens with a separator and an extension, trimming punctuation and line suffixes', () => {
    expect(
      splitTypedPaths('see `src/core/memory/index.ts:42`, and (C:\\repo\\a.vue) plus notes/readme.').paths,
    ).toEqual(['src/core/memory/index.ts', 'C:\\repo\\a.vue']);
  });

  it('ignores URLs, dot-directories and bare names as file paths', () => {
    expect(splitTypedPaths('https://example.com/a.js ~/.damocles index.ts a/b').paths).toEqual([]);
    expect(splitTypedPaths('config/.eslintrc.json').paths).toEqual(['config/.eslintrc.json']);
  });

  it('keeps a file path out of the query words', () => {
    const typed = splitTypedPaths('Use SaveObservation to record that C:\\Users\\astefanopoulos\\.claude\\CLAUDE.md holds global agent rules');
    expect(typed.paths).toEqual(['C:\\Users\\astefanopoulos\\.claude\\CLAUDE.md']);
    expect(queryTerms(typed.text).terms).toEqual(['use', 'saveobservation', 'record', 'holds', 'global', 'agent', 'rules']);
  });

  it('keeps a bare file name as a word without its extension, but a version whole', () => {
    const typed = splitTypedPaths('OrganizationScope.php scopes `Eloquent` queries, see v2.36.0 and README.md.');
    expect(typed.paths).toEqual([]);
    expect(queryTerms(typed.text).terms).toEqual(['organizationscope', 'scopes', 'eloquent', 'queries', 'v2', '36', 'readme']);
  });

  it('keeps only the last segment of a directory path, and leaves slash-joined words alone', () => {
    const typed = splitTypedPaths('open C:\\GameDev\\iemis and ~/work/pi-anthropic-auth, see src/core/memory, app/Http and/or');
    expect(typed.paths).toEqual([]);
    expect(queryTerms(typed.text).terms).toEqual(['open', 'iemis', 'pi', 'anthropic', 'auth', 'memory', 'app', 'http']);
  });
});

describe('fileProximityMatcher', () => {
  const computeFileProximity = (memory: FileFields, filePath: string): number =>
    fileProximityMatcher(filePath)(normalizeFileFields(memory));

  it('gives full credit for a two-segment suffix and partial for a bare filename', () => {
    expect(computeFileProximity({ content: 'touches foo/index.ts' }, 'src/foo/index.ts')).toBe(1);
    expect(computeFileProximity({ content: 'x', filesModified: ['C:\\r\\src\\foo\\index.ts'] }, 'src/foo/index.ts')).toBe(1);
    expect(computeFileProximity({ content: 'edited bar/index.ts' }, 'src/foo/index.ts')).toBeCloseTo(0.4, 10);
    expect(computeFileProximity({ content: 'nothing' }, 'src/foo/index.ts')).toBe(0);
  });
});

describe('scoreGatedEntry', () => {
  const now = Date.UTC(2026, 0, 1);

  it('weights relevance, file, recency and retrieval with no scope term', () => {
    const { score, breakdown } = scoreGatedEntry({
      lexical: { relevance: 1, matchedIdf: 2, queryIdf: 2 },
      fileProximity: 1,
      updatedAt: now,
      now,
      retrievalCount: 10,
      sourceCount: 1,
      kind: 'fact',
      fileChangeCount: 0,
    });
    expect(breakdown.recency).toBe(1);
    expect(breakdown.retrievalBoost).toBeCloseTo(1, 10);
    expect(breakdown.sourceCountBoost).toBeCloseTo(0.05, 10);
    expect(score).toBeCloseTo(0.55 + 0.15 + 0.15 + 0.1 + 0.05, 10);
    expect(breakdown).not.toHaveProperty('scopeWeight');
  });

  it('penalizes a stale observation only', () => {
    const base = { lexical: { relevance: 1, matchedIdf: 1, queryIdf: 1 }, fileProximity: 0, updatedAt: now, now, retrievalCount: 0, sourceCount: 1 };
    const stale = scoreGatedEntry({ ...base, kind: 'observation', fileChangeCount: 5 });
    const fact = scoreGatedEntry({ ...base, kind: 'fact', fileChangeCount: 5 });
    expect(stale.breakdown.stalenessPenalty).toBeLessThan(1);
    expect(fact.breakdown.stalenessPenalty).toBe(1);
  });

  it('breaks score ties by scope, then recency', () => {
    const ranked = [
      { score: 0.5, scope: 'global' as const, updatedAt: 3 },
      { score: 0.5, scope: 'session' as const, updatedAt: 1 },
      { score: 0.5, scope: 'project' as const, updatedAt: 1 },
      { score: 0.5, scope: 'project' as const, updatedAt: 2 },
      { score: 0.9, scope: 'global' as const, updatedAt: 0 },
    ].sort(compareRank);
    expect(ranked.map(r => `${r.scope}${r.updatedAt}`)).toEqual(['global0', 'session1', 'project2', 'project1', 'global3']);
  });
});

describe('assignTiers', () => {
  const c = (id: string, over: Partial<TierCandidate> = {}): TierCandidate => ({
    id,
    fullAllowed: true,
    liveCompact: false,
    tokens: { full: 100, compact: 20 },
    ...over,
  });
  const limits = { full: 2, compact: 2, tokenBudget: 10_000 };

  it('fills full then compact, and counts the rest as over budget', () => {
    const plan = assignTiers([c('a'), c('b'), c('c'), c('d'), c('e')], limits);
    expect([...plan.tiers]).toEqual([['a', 'full'], ['b', 'full'], ['c', 'compact'], ['d', 'compact']]);
    expect(plan.overBudget).toBe(1);
  });

  it('caps a file-only match at compact', () => {
    const plan = assignTiers([c('file', { fullAllowed: false }), c('b')], limits);
    expect(plan.tiers.get('file')).toBe('compact');
    expect(plan.tiers.get('b')).toBe('full');
  });

  it('upgrades a live compact entry only when it ranks into the full tier', () => {
    const up = assignTiers([c('live', { liveCompact: true })], limits);
    expect(up.tiers.get('live')).toBe('full');

    const stays = assignTiers([c('a'), c('b'), c('live', { liveCompact: true }), c('d')], limits);
    expect(stays.tiers.has('live')).toBe(false);
    expect(stays.alreadyInContext).toBe(1);
    expect(stays.tiers.get('d')).toBe('compact');
  });

  it('demotes the lowest full entries before dropping compact ones, within the compact limit', () => {
    const plan = assignTiers([c('a'), c('b'), c('c'), c('d')], { full: 2, compact: 2, tokenBudget: 150 });
    // 100+100+20+20 = 240 > 150: demoting b takes the last compact slot from d, leaving 140.
    expect([...plan.tiers]).toEqual([['a', 'full'], ['b', 'compact'], ['c', 'compact']]);
    expect(plan.overBudget).toBe(1);

    const tight = assignTiers([c('a'), c('b'), c('c'), c('d')], { full: 2, compact: 2, tokenBudget: 45 });
    expect([...tight.tiers.keys()]).toEqual(['a', 'b']);
    expect(tight.overBudget).toBe(2);
  });

  it('never renders compact entries past the compact limit, even when demoting', () => {
    const plan = assignTiers([c('a'), c('b')], { full: 2, compact: 0, tokenBudget: 150 });
    expect([...plan.tiers]).toEqual([['a', 'full']]);
    expect(plan.overBudget).toBe(1);

    const upgradeOnly = assignTiers([c('live', { liveCompact: true }), c('b')], { full: 1, compact: 0, tokenBudget: 50 });
    expect(upgradeOnly.tiers.size).toBe(0);
    expect(upgradeOnly.alreadyInContext).toBe(1);
    expect(upgradeOnly.overBudget).toBe(1);
  });

  it('drops a budget-demoted upgrade instead of re-sending it compact', () => {
    const plan = assignTiers([c('live', { liveCompact: true })], { full: 2, compact: 2, tokenBudget: 50 });
    expect(plan.tiers.size).toBe(0);
    expect(plan.alreadyInContext).toBe(1);
  });
});
