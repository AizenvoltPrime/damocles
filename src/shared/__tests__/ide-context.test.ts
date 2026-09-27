import { describe, it, expect } from 'vitest';
import { formatIdeContextBlock, splitIdeContext, type IdeContextBlock } from '../ide-context';

describe('IDE context block', () => {
  it('round-trips an opened file and a selection through format and split', () => {
    const blocks: IdeContextBlock[] = [
      { type: 'opened_file', filePath: 'c:\\GameDev\\iemis\\app\\Scopes\\OrganizationScope.php' },
      { type: 'selection', filePath: 'c:\\repo\\a.ts', startLine: 3, endLine: 9, content: 'const a = 1;\n\nconst b = 2;' },
      { type: 'selection', filePath: '/repo/b.ts', startLine: 1, endLine: 1, content: '' },
    ];
    for (const block of blocks) {
      expect(splitIdeContext(`${formatIdeContextBlock(block)}\nfix this`)).toEqual({ context: block, text: 'fix this' });
    }
  });

  it('reads the stored wire format', () => {
    const stored =
      '<ide_opened_file>The user opened the file c:\\x.jsonl in the IDE. This may or may not be related to the current task.</ide_opened_file>\nwhat day is it';
    expect(splitIdeContext(stored)).toEqual({ context: { type: 'opened_file', filePath: 'c:\\x.jsonl' }, text: 'what day is it' });
  });

  // The close marker is the whole relatedness sentence, so a bare closing tag in the selection is content.
  it('keeps a closing tag inside the selected text as content', () => {
    const block: IdeContextBlock = { type: 'selection', filePath: '/r/x.md', startLine: 1, endLine: 2, content: 'a </ide_selection> b\n</ide_selection>' };
    expect(splitIdeContext(`${formatIdeContextBlock(block)}\nexplain`)).toEqual({ context: block, text: 'explain' });
  });

  it('round-trips CRLF selection content and keeps CRLF in the typed text', () => {
    const block: IdeContextBlock = { type: 'selection', filePath: 'c:\\r\\a.ts', startLine: 4, endLine: 5, content: 'one\r\ntwo\r\n' };
    expect(splitIdeContext(`${formatIdeContextBlock(block)}\nfirst\r\nsecond`)).toEqual({ context: block, text: 'first\r\nsecond' });
  });

  it('takes only the first leading block, leaving a second one in the typed text', () => {
    const opened = formatIdeContextBlock({ type: 'opened_file', filePath: '/r/a.ts' });
    const selection = formatIdeContextBlock({ type: 'selection', filePath: '/r/b.ts', startLine: 1, endLine: 1, content: 'x' });
    expect(splitIdeContext(`${opened}\n${selection}\nfix`)).toEqual({
      context: { type: 'opened_file', filePath: '/r/a.ts' },
      text: `${selection}\nfix`,
    });
  });

  it('leaves text alone when the block is not leading or not closed', () => {
    const block = formatIdeContextBlock({ type: 'opened_file', filePath: '/r/a.ts' });
    expect(splitIdeContext(`see ${block}`)).toEqual({ context: null, text: `see ${block}` });
    expect(splitIdeContext('<ide_opened_file>The user opened the file x')).toEqual({
      context: null,
      text: '<ide_opened_file>The user opened the file x',
    });
  });
});
