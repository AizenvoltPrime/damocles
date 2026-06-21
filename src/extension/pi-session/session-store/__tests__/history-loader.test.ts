import { describe, it, expect } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { reconstructMessages } from '../history-loader';
import { stripIdeContext } from '../ide-context';
import { DAMOCLES_ORIGINAL_INPUT_ENTRY } from '../constants';

function userMsg(id: string, text: string): SessionEntry {
  return { id, type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } } as unknown as SessionEntry;
}
function assistantMsg(id: string, text: string): SessionEntry {
  return { id, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } } as unknown as SessionEntry;
}
function originalInput(userEntryId: string, original: string): SessionEntry {
  return { id: `c-${userEntryId}`, type: 'custom', customType: DAMOCLES_ORIGINAL_INPUT_ENTRY, data: { userEntryId, original } } as unknown as SessionEntry;
}
function compactionEntry(id: string, summary: string): SessionEntry {
  return {
    id,
    type: 'compaction',
    summary,
    tokensBefore: 1234,
    timestamp: '2026-06-20T20:22:57.439Z',
  } as unknown as SessionEntry;
}

describe('stripIdeContext', () => {
  it('strips a merged opened-file wrapper, keeping the real message (pi merges adjacent text blocks)', () => {
    const stored =
      '<ide_opened_file>The user opened the file c:\\x.jsonl in the IDE. This may or may not be related to the current task.</ide_opened_file>\nwhat day is it';
    expect(stripIdeContext(stored)).toBe('what day is it');
  });

  it('strips a multi-line selection wrapper, keeping the real message', () => {
    const stored =
      '<ide_selection>The user selected the lines 1 to 5 from x.ts:\nconst a = 1;\n\nThis may or may not be related to the current task.</ide_selection>\nfix this';
    expect(stripIdeContext(stored)).toBe('fix this');
  });

  it('reduces a standalone wrapper block (image-message case) to empty', () => {
    expect(stripIdeContext('<ide_opened_file>x</ide_opened_file>')).toBe('');
  });

  it('leaves a normal message untouched', () => {
    expect(stripIdeContext('just a normal message')).toBe('just a normal message');
  });

  it('only strips a leading wrapper — a closing tag a user typed mid-message survives', () => {
    const text = 'please keep this </ide_opened_file> literal mid-text';
    expect(stripIdeContext(text)).toBe(text);
  });
});

describe('reconstructMessages — compaction', () => {
  it('replaces pre-compaction messages with a summary marker and keeps post-compaction messages', () => {
    const branch = [
      userMsg('u1', 'old question'),
      assistantMsg('a1', 'old answer'),
      compactionEntry('c1', 'the summary'),
      userMsg('u2', 'what did I ask so far'),
      assistantMsg('a2', 'you asked about old things'),
    ];
    const { messages } = reconstructMessages(branch);

    expect(messages.map((m) => m.kind)).toEqual(['compaction', 'user', 'assistant']);
    const marker = messages[0] as { kind: 'compaction'; summary: string; preTokens: number; timestamp: number; entryId: string };
    expect(marker.summary).toBe('the summary');
    expect(marker.preTokens).toBe(1234);
    expect(marker.timestamp).toBe(Date.parse('2026-06-20T20:22:57.439Z'));
    // The marker carries the compaction entry id — the tree node rewind-to-before-compaction branches at.
    expect(marker.entryId).toBe('c1');
    expect((messages[1] as { content: string }).content).toBe('what did I ask so far');
  });

  it('a session with no compaction is unaffected', () => {
    const branch = [userMsg('u1', 'hi'), assistantMsg('a1', 'hello')];
    const { messages } = reconstructMessages(branch);
    expect(messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
  });
});

describe('reconstructMessages — original slash-command input', () => {
  it('shows the original typed command instead of pi\'s expanded body', () => {
    const branch = [
      userMsg('u1', 'Hello day is Tuesday'), // pi's expansion of /example
      assistantMsg('a1', 'Tuesday it is.'),
      originalInput('u1', '/example what is the day'),
    ];
    const { messages } = reconstructMessages(branch);
    expect((messages[0] as { content: string }).content).toBe('/example what is the day');
  });

  it('leaves a normal user message (no sidecar) untouched', () => {
    const branch = [userMsg('u1', 'just a normal message'), assistantMsg('a1', 'ok')];
    const { messages } = reconstructMessages(branch);
    expect((messages[0] as { content: string }).content).toBe('just a normal message');
  });

  it('substitutes the text but keeps image blocks of an expanded message', () => {
    const branch = [
      {
        id: 'u1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'Hello day is Tuesday' }] },
      } as unknown as SessionEntry,
      assistantMsg('a1', 'ok'),
      originalInput('u1', '/example what is the day'),
    ];
    const { messages } = reconstructMessages(branch);
    const user = messages[0] as { content: string; contentBlocks?: { type: string; text?: string }[] };
    expect(user.content).toBe('/example what is the day');
    expect(user.contentBlocks?.some((b) => b.type === 'image')).toBe(true);
    expect(user.contentBlocks?.find((b) => b.type === 'text')?.text).toBe('/example what is the day');
  });
});
