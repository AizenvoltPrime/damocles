import { describe, it, expect } from 'vitest';
import { stripIdeContext } from '../history-loader';

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
