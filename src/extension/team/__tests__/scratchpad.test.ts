import { describe, it, expect } from 'vitest';
import { MAX_APPEND_ONLY_ENTRIES, Scratchpad } from '../scratchpad';

describe('Scratchpad — read tracking', () => {
  it('treats an unread section as never read (version 0)', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'v1 body', 'Specialist');
    expect(sp.getReadVersion('Lead', 'findings')).toBe(0);
  });

  it('marks a section as read at its current version when the reader calls markRead', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'v1 body', 'Specialist');
    sp.markRead('Lead', 'findings');
    expect(sp.getReadVersion('Lead', 'findings')).toBe(1);
  });

  it('auto-marks the author as having read their own write', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'v1 body', 'Specialist');
    expect(sp.getReadVersion('Specialist', 'findings')).toBe(1);
  });

  it('flags a section as stale once the author writes a new version', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'v1 body', 'Specialist');
    sp.markRead('Lead', 'findings');
    sp.set('findings', 'v2 body', 'Specialist');
    expect(sp.getReadVersion('Lead', 'findings')).toBe(1);
    const stale = sp.getStaleSectionsFor('Lead', 'Specialist');
    expect(stale).toEqual([
      { section: 'findings', currentVersion: 2, lastReadVersion: 1, author: 'Specialist' },
    ]);
  });

  it('markAllRead snapshots every section at its current version', () => {
    const sp = new Scratchpad();
    sp.set('a', 'body', 'X');
    sp.set('b', 'body', 'X');
    sp.markAllRead('Lead');
    expect(sp.getReadVersion('Lead', 'a')).toBe(1);
    expect(sp.getReadVersion('Lead', 'b')).toBe(1);
  });

  it('never regresses a read version when markRead is called with a stale snapshot', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'v1', 'S');
    sp.set('findings', 'v2', 'S');
    sp.markRead('Lead', 'findings');
    expect(sp.getReadVersion('Lead', 'findings')).toBe(2);
  });

  it('throws when a non-original author tries to overwrite a section', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'from A', 'A');
    expect(() => sp.set('findings', 'attempted rewrite', 'B')).toThrow(/owned by "A"/);
  });

  it('preserves original content and version when a non-original author write is rejected', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'from A', 'A');
    expect(() => sp.set('findings', 'rewrite', 'B')).toThrow();
    const entry = sp.get('findings');
    expect(entry?.content).toBe('from A');
    expect(entry?.author).toBe('A');
    expect(entry?.version).toBe(1);
  });

  it('does not mark the rejected writer as having read the section', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'from A', 'A');
    expect(() => sp.set('findings', 'rewrite', 'B')).toThrow();
    expect(sp.getReadVersion('B', 'findings')).toBe(0);
  });

  it('allows the original author to keep writing new versions', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'v1', 'A');
    sp.set('findings', 'v2', 'A');
    sp.set('findings', 'v3', 'A');
    expect(sp.get('findings')?.version).toBe(3);
    expect(sp.get('findings')?.author).toBe('A');
  });

  it('getSectionsAuthoredBy returns every section the agent currently owns', () => {
    const sp = new Scratchpad();
    sp.set('findings-backend', 'body', 'Backend');
    sp.set('findings-frontend', 'body', 'Frontend');
    sp.set('notes', 'body', 'Backend');
    expect(sp.getSectionsAuthoredBy('Backend').map(e => e.section).sort()).toEqual(['findings-backend', 'notes']);
    expect(sp.getSectionsAuthoredBy('Frontend').map(e => e.section)).toEqual(['findings-frontend']);
  });

  it('returns no stale sections when the reader is up to date with every authored section', () => {
    const sp = new Scratchpad();
    sp.set('one', 'body', 'S');
    sp.set('two', 'body', 'S');
    sp.markRead('Lead', 'one');
    sp.markRead('Lead', 'two');
    expect(sp.getStaleSectionsFor('Lead', 'S')).toEqual([]);
  });

  it('markRead on a missing section is a no-op', () => {
    const sp = new Scratchpad();
    sp.markRead('Lead', 'nope');
    expect(sp.getReadVersion('Lead', 'nope')).toBe(0);
  });

  it('fires the rejection subscriber with section, attemptedBy, and owner before throwing', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'from A', 'A');
    const rejections: Array<{ section: string; attemptedBy: string; owner: string }> = [];
    sp.subscribeRejection((r) => rejections.push(r));
    expect(() => sp.set('findings', 'rewrite', 'B')).toThrow();
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ section: 'findings', attemptedBy: 'B', owner: 'A', reason: 'non-owner-overwrite' });
  });

  it('does not fire the rejection subscriber for successful same-author writes', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'v1', 'A');
    const rejections: unknown[] = [];
    sp.subscribeRejection((r) => rejections.push(r));
    sp.set('findings', 'v2', 'A');
    expect(rejections).toHaveLength(0);
  });
});

describe('Scratchpad — immutable system-owned section (mission-brief)', () => {
  it('seedImmutable writes version 1 authored by system, verbatim', () => {
    const sp = new Scratchpad();
    sp.seedImmutable('mission-brief', 'THE AUTHORITATIVE SPEC');
    const entry = sp.get('mission-brief');
    expect(entry?.content).toBe('THE AUTHORITATIVE SPEC');
    expect(entry?.author).toBe('system');
    expect(entry?.version).toBe(1);
  });

  it('fires subscribers on seed so the runner can persist + broadcast it', () => {
    const sp = new Scratchpad();
    const seen: string[] = [];
    sp.subscribe((e) => seen.push(e.section));
    sp.seedImmutable('mission-brief', 'spec');
    expect(seen).toEqual(['mission-brief']);
  });

  it('records the system author as having read the seeded section', () => {
    const sp = new Scratchpad();
    sp.seedImmutable('mission-brief', 'spec');
    expect(sp.getReadVersion('system', 'mission-brief')).toBe(1);
  });

  it('rejects any agent write to the locked section (throws, fires rejection with immutable-section)', () => {
    const sp = new Scratchpad();
    sp.seedImmutable('mission-brief', 'spec');
    const rejections: Array<{ section: string; attemptedBy: string; owner: string; reason: string }> = [];
    sp.subscribeRejection((r) => rejections.push(r));
    expect(() => sp.set('mission-brief', 'hijack', 'Backend')).toThrow(/immutable/);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ section: 'mission-brief', attemptedBy: 'Backend', reason: 'immutable-section' });
  });

  it('rejects even a second system write to the locked section', () => {
    const sp = new Scratchpad();
    sp.seedImmutable('mission-brief', 'spec');
    expect(() => sp.set('mission-brief', 'v2', 'system')).toThrow(/immutable/);
    expect(sp.get('mission-brief')?.content).toBe('spec');
    expect(sp.get('mission-brief')?.version).toBe(1);
  });
});

describe('Scratchpad — append-only shared section (verification ledger)', () => {
  it('seedAppendOnly creates an empty system-owned section at version 1', () => {
    const sp = new Scratchpad();
    sp.seedAppendOnly('verification');
    const entry = sp.get('verification');
    expect(entry?.content).toBe('');
    expect(entry?.author).toBe('system');
    expect(entry?.version).toBe(1);
  });

  it('fires subscribers on seed so the runner persists + streams it', () => {
    const sp = new Scratchpad();
    const seen: string[] = [];
    sp.subscribe((e) => seen.push(e.section));
    sp.seedAppendOnly('verification');
    expect(seen).toEqual(['verification']);
  });

  it('accepts appends from ANY agent (not just the section author)', () => {
    const sp = new Scratchpad();
    sp.seedAppendOnly('verification');
    expect(() => sp.appendTo('verification', 'entry from A')).not.toThrow();
    expect(() => sp.appendTo('verification', 'entry from B')).not.toThrow();
  });

  it('lands both appends in order — neither overwrites the other', () => {
    const sp = new Scratchpad();
    sp.seedAppendOnly('verification');
    sp.appendTo('verification', 'entry from A');
    sp.appendTo('verification', 'entry from B');
    expect(sp.get('verification')?.content).toBe('entry from A\nentry from B');
    expect(sp.get('verification')?.version).toBe(3);
  });

  it('fires subscribers on every append', () => {
    const sp = new Scratchpad();
    sp.seedAppendOnly('verification');
    const versions: number[] = [];
    sp.subscribe((e) => versions.push(e.version));
    sp.appendTo('verification', 'one');
    sp.appendTo('verification', 'two');
    expect(versions).toEqual([2, 3]);
  });

  it('keeps single-owner enforcement intact on NORMAL sections', () => {
    const sp = new Scratchpad();
    sp.seedAppendOnly('verification');
    sp.set('findings', 'from A', 'A');
    expect(() => sp.set('findings', 'rewrite', 'B')).toThrow(/owned by "A"/);
  });

  it('keeps an immutable section rejecting ALL writes', () => {
    const sp = new Scratchpad();
    sp.seedImmutable('mission-brief', 'spec');
    expect(() => sp.set('mission-brief', 'hijack', 'A')).toThrow(/immutable/);
    expect(() => sp.appendTo('mission-brief', 'sneak')).toThrow(/not an append-only section/);
  });

  it('rejects set() on an append-only section — even from an agent literally named "system"', () => {
    // The ledger's owner is the string `system` and nothing reserves that name in the lead's roster, so
    // an owner-check-only guard would let an agent named `system` replace the ledger wholesale. A ledger
    // that can be silently rewritten is worthless as evidence.
    const sp = new Scratchpad();
    sp.seedAppendOnly('verification');
    sp.appendTo('verification', 'entry from A');
    expect(() => sp.set('verification', 'wiped', 'system')).toThrow(/append-only/);
    expect(() => sp.set('verification', 'wiped', 'A')).toThrow(/append-only/);
    expect(sp.get('verification')!.content).toBe('entry from A');
  });

  it('bounds an append-only section as a ring, dropping the oldest entries', () => {
    // Every append re-persists and re-emits the WHOLE section, so an unbounded ledger is quadratic in
    // append count and unbounded in payload size.
    const sp = new Scratchpad();
    sp.seedAppendOnly('verification');
    for (let i = 0; i < MAX_APPEND_ONLY_ENTRIES + 25; i++) sp.appendTo('verification', `entry-${i}`);
    const lines = sp.get('verification')!.content.split('\n');
    expect(lines).toHaveLength(MAX_APPEND_ONLY_ENTRIES);
    expect(lines[0]).toBe('entry-25');
    expect(lines.at(-1)).toBe(`entry-${MAX_APPEND_ONLY_ENTRIES + 24}`);
  });

  it('isAppendOnly distinguishes the ledger from normal and immutable sections', () => {
    const sp = new Scratchpad();
    sp.seedAppendOnly('verification');
    sp.seedImmutable('mission-brief', 'spec');
    sp.set('findings', 'from A', 'A');
    expect(sp.isAppendOnly('verification')).toBe(true);
    expect(sp.isAppendOnly('mission-brief')).toBe(false);
    expect(sp.isAppendOnly('findings')).toBe(false);
    expect(sp.isAppendOnly('nope')).toBe(false);
  });

  it('rejects appendTo on a section that was never seeded append-only', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'from A', 'A');
    expect(() => sp.appendTo('findings', 'sneak')).toThrow(/not an append-only section/);
    expect(() => sp.appendTo('nope', 'sneak')).toThrow(/not an append-only section/);
  });

  it('leaves the appender still needing a full read of the entries it never saw', () => {
    // The record tool echoes only the ledger tail, so an appender has seen its own entry and nothing
    // else. Marking it as holding the whole ledger would hide every earlier run from it.
    const sp = new Scratchpad();
    sp.seedAppendOnly('verification');
    sp.appendTo('verification', 'entry from A');
    sp.markRead('B', 'verification');
    sp.appendTo('verification', 'entry from B');
    expect(sp.hasCurrentRead('B', 'verification')).toBe(false);
  });
});

describe('Scratchpad read outcome counters', () => {
  it('reports zeros for a reader that has never read anything', () => {
    const sp = new Scratchpad();
    expect(sp.getReadStats('Nobody')).toEqual({ markerHits: 0, fullReturns: 0 });
  });

  it('reports zeros in total on a fresh scratchpad', () => {
    const sp = new Scratchpad();
    expect(sp.getReadStats()).toEqual({ markerHits: 0, fullReturns: 0 });
  });

  it('increments only the named counter', () => {
    const sp = new Scratchpad();
    sp.recordReadOutcome('Lead', 'full');
    expect(sp.getReadStats('Lead')).toEqual({ markerHits: 0, fullReturns: 1 });
    sp.recordReadOutcome('Lead', 'marker');
    expect(sp.getReadStats('Lead')).toEqual({ markerHits: 1, fullReturns: 1 });
  });

  it('counts per section returned, so one all-sections read records several outcomes', () => {
    const sp = new Scratchpad();
    sp.recordReadOutcome('Lead', 'marker');
    sp.recordReadOutcome('Lead', 'marker');
    sp.recordReadOutcome('Lead', 'full');
    expect(sp.getReadStats('Lead')).toEqual({ markerHits: 2, fullReturns: 1 });
  });

  it('keeps readers isolated and sums them for the team total', () => {
    const sp = new Scratchpad();
    sp.recordReadOutcome('Lead', 'marker');
    sp.recordReadOutcome('Specialist', 'full');
    sp.recordReadOutcome('Specialist', 'full');
    expect(sp.getReadStats('Lead')).toEqual({ markerHits: 1, fullReturns: 0 });
    expect(sp.getReadStats('Specialist')).toEqual({ markerHits: 0, fullReturns: 2 });
    expect(sp.getReadStats()).toEqual({ markerHits: 1, fullReturns: 2 });
  });

  it('returns a snapshot a caller cannot mutate into the store', () => {
    const sp = new Scratchpad();
    sp.recordReadOutcome('Lead', 'full');
    const stats = sp.getReadStats('Lead');
    stats.fullReturns = 99;
    expect(sp.getReadStats('Lead')).toEqual({ markerHits: 0, fullReturns: 1 });
  });
});

/**
 * `hasCurrentRead` is the marker predicate itself, so these tests exercise the same code the tool calls.
 * Re-implementing the comparison here would pass even if the call site flipped it.
 */
describe('Scratchpad.hasCurrentRead, the predicate that drives the unchanged marker', () => {
  it('is false for a section the reader has never read, so the first read is full', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'Specialist');
    expect(sp.getReadVersion('Lead', 'findings')).toBe(0);
    expect(sp.hasCurrentRead('Lead', 'findings')).toBe(false);
  });

  it('is false for a section that does not exist', () => {
    const sp = new Scratchpad();
    expect(sp.hasCurrentRead('Lead', 'never-written')).toBe(false);
  });

  it('is true after markRead, so the next read is a marker', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'Specialist');
    sp.markRead('Lead', 'findings');
    expect(sp.hasCurrentRead('Lead', 'findings')).toBe(true);
  });

  it('is true for the author of a full overwrite, who supplied the whole content', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'Specialist');
    expect(sp.hasCurrentRead('Specialist', 'findings')).toBe(true);
  });

  it('reports every section version after markAllRead', () => {
    const sp = new Scratchpad();
    sp.set('a', 'body', 'X');
    sp.set('b', 'body', 'X');
    sp.markAllRead('Lead');
    for (const entry of sp.getAll()) {
      expect(sp.getReadVersion('Lead', entry.section)).toBe(entry.version);
    }
  });

  it('falls behind again once a peer writes a new version', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'v1', 'Specialist');
    sp.markRead('Lead', 'findings');
    sp.set('findings', 'v2', 'Specialist');
    expect(sp.hasCurrentRead('Lead', 'findings')).toBe(false);
  });

  it('leaves the recorded version correct after a marker read re-marks an already known section', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'v1', 'Specialist');
    sp.markRead('Lead', 'findings');
    sp.markRead('Lead', 'findings');
    expect(sp.getReadVersion('Lead', 'findings')).toBe(1);
  });

  it('bumps the append-only ledger above a reader recorded version, so it reads full again', () => {
    const sp = new Scratchpad();
    sp.seedAppendOnly('verification');
    sp.appendTo('verification', 'run 1');
    sp.markRead('Lead', 'verification');
    expect(sp.hasCurrentRead('Lead', 'verification')).toBe(true);

    sp.appendTo('verification', 'run 2');
    expect(sp.get('verification')!.version).toBe(3);
    expect(sp.getReadVersion('Lead', 'verification')).toBe(2);
    expect(sp.hasCurrentRead('Lead', 'verification')).toBe(false);
  });

  it('keeps the immutable mission-brief at version 1, so it reads full once then marker forever', () => {
    const sp = new Scratchpad();
    sp.seedImmutable('mission-brief', 'THE SPEC');
    expect(sp.getReadVersion('system', 'mission-brief')).toBe(1);
    expect(sp.getReadVersion('Lead', 'mission-brief')).toBe(0);

    sp.markRead('Lead', 'mission-brief');
    expect(sp.get('mission-brief')!.version).toBe(1);
    expect(sp.hasCurrentRead('Lead', 'mission-brief')).toBe(true);
  });
});

describe('Scratchpad.clearReader', () => {
  it('drops the reader read versions, so its next read of every section is full again', () => {
    const sp = new Scratchpad();
    sp.seedImmutable('mission-brief', 'THE SPEC');
    sp.set('findings', 'body', 'Specialist');
    sp.markAllRead('A');
    expect(sp.hasCurrentRead('A', 'mission-brief')).toBe(true);

    sp.clearReader('A');

    expect(sp.hasCurrentRead('A', 'mission-brief')).toBe(false);
    expect(sp.hasCurrentRead('A', 'findings')).toBe(false);
  });

  it('drops the reader outcome counters', () => {
    const sp = new Scratchpad();
    sp.recordReadOutcome('A', 'marker');
    sp.recordReadOutcome('A', 'full');
    sp.clearReader('A');
    expect(sp.getReadStats('A')).toEqual({ markerHits: 0, fullReturns: 0 });
  });

  it('leaves every other reader untouched', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'Specialist');
    sp.markRead('A', 'findings');
    sp.markRead('B', 'findings');
    sp.recordReadOutcome('B', 'full');

    sp.clearReader('A');

    expect(sp.hasCurrentRead('B', 'findings')).toBe(true);
    expect(sp.getReadStats('B')).toEqual({ markerHits: 0, fullReturns: 1 });
  });
});
