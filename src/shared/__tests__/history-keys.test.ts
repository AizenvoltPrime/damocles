import { describe, expect, it } from 'vitest';
import { historyStepOf, type HistoryKey } from '../history-keys';

const key = (code: string, mods: Partial<Omit<HistoryKey, 'code'>> = {}): HistoryKey => ({ code, alt: false, control: false, meta: false, shift: false, ...mods });

describe('historyStepOf', () => {
  it("takes Alt+Left and Alt+Right outside macOS, and Cmd+[ and Cmd+] on macOS, as browsers do", () => {
    expect(historyStepOf(key('ArrowLeft', { alt: true }), false)).toBe('back');
    expect(historyStepOf(key('ArrowRight', { alt: true }), false)).toBe('forward');
    expect(historyStepOf(key('BracketLeft', { meta: true }), true)).toBe('back');
    expect(historyStepOf(key('BracketRight', { meta: true }), true)).toBe('forward');
  });

  it('leaves every other key and modifier set to the page', () => {
    expect(historyStepOf(key('ArrowLeft'), false)).toBeUndefined();
    expect(historyStepOf(key('ArrowLeft', { alt: true, shift: true }), false)).toBeUndefined();
    expect(historyStepOf(key('ArrowLeft', { alt: true, control: true }), false)).toBeUndefined();
    expect(historyStepOf(key('BracketLeft', { meta: true }), false)).toBeUndefined();
    expect(historyStepOf(key('ArrowLeft', { alt: true }), true)).toBeUndefined();
    expect(historyStepOf(key('BracketLeft', { meta: true, alt: true }), true)).toBeUndefined();
  });
});
