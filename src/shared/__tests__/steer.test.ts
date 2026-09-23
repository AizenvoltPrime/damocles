import { describe, it, expect } from 'vitest';
import { STEER_INSTRUCTION_PREFIX, buildResumePrompt, wrapSteerMessage, stripSteerPrefix } from '../steer';

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

describe('buildResumePrompt', () => {
  const CONTEXT =
    'You were interrupted by the operator before finishing. Continue from where you left off; check current state before redoing any step that may have been cut off.';

  it('without a message is the plain resume context', () => {
    expect(buildResumePrompt()).toBe(CONTEXT);
    expect(buildResumePrompt('   ')).toBe(CONTEXT);
  });

  it('with a message is a steer: the marker first, then the message, then the resume context', () => {
    expect(buildResumePrompt('also run the tests')).toBe(wrapSteerMessage(`also run the tests${String.fromCharCode(10).repeat(2)}${CONTEXT}`));
    expect(buildResumePrompt('x').split(String.fromCharCode(10))[0]).toBe(STEER_INSTRUCTION_PREFIX);
  });
});
