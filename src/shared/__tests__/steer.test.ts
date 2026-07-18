import { describe, it, expect } from 'vitest';
import { STEER_INSTRUCTION_PREFIX, wrapSteerMessage, stripSteerPrefix } from '../steer';

describe('steer message tagging', () => {
  it('wraps a raw message with the priority marker on its own line', () => {
    expect(wrapSteerMessage('do X')).toBe(`${STEER_INSTRUCTION_PREFIX}\ndo X`);
  });

  it('strips the marker and its trailing newline for display', () => {
    expect(stripSteerPrefix(wrapSteerMessage('do X'))).toBe('do X');
  });

  it('leaves an unmarked message unchanged', () => {
    expect(stripSteerPrefix('plain instruction')).toBe('plain instruction');
  });

  it('round-trips multi-line messages', () => {
    const msg = 'line one\nline two';
    expect(stripSteerPrefix(wrapSteerMessage(msg))).toBe(msg);
  });
});
