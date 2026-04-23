import { describe, it, expect } from 'vitest';
import { Scratchpad } from '../scratchpad';

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
