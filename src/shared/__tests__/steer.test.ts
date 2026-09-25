import { describe, it, expect } from 'vitest';
import {
  STEER_INSTRUCTION_PREFIX,
  buildResumePrompt,
  describeUserSteer,
  formatTeamUserSteerPrefix,
  formatUserSteerPrefix,
  wrapSteerMessage,
  stripSteerPrefix,
} from '../steer';

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

  it('wraps an empty message (an image-only steer) as the marker line alone', () => {
    expect(wrapSteerMessage('')).toBe(STEER_INSTRUCTION_PREFIX);
    expect(stripSteerPrefix(wrapSteerMessage(''))).toBe('');
  });
});

describe('describeUserSteer', () => {
  const quote = (m: string): string => `"${m}"`;

  it('quotes the message and adds nothing without images', () => {
    expect(describeUserSteer({ message: 'use v2' }, quote)).toBe('"use v2"');
    expect(describeUserSteer({ message: 'use v2', imageCount: 0 }, quote)).toBe('"use v2"');
  });

  it('adds a singular or plural image count', () => {
    expect(describeUserSteer({ message: 'use v2', imageCount: 1 }, quote)).toBe('"use v2" (+1 image)');
    expect(describeUserSteer({ message: 'use v2', imageCount: 2 }, quote)).toBe('"use v2" (+2 images)');
  });

  it('reads (no text) for an image-only steer', () => {
    expect(describeUserSteer({ message: '', imageCount: 1 }, quote)).toBe('(no text) (+1 image)');
  });

  it('uses the caller quote', () => {
    expect(describeUserSteer({ message: 'a\nb' }, JSON.stringify)).toBe('"a\\nb"');
  });
});

describe('user steer prefixes', () => {
  it('formatUserSteerPrefix carries the image suffix', () => {
    expect(formatUserSteerPrefix([{ message: 'use v2', imageCount: 2 }])).toBe('[User steered this agent mid-task: "use v2" (+2 images)]\n');
  });

  it('formatTeamUserSteerPrefix carries the image suffix and (no text)', () => {
    expect(formatTeamUserSteerPrefix([{ memberName: 'A', message: '', imageCount: 1 }])).toBe(
      '[User steered team member "A" mid-task: (no text) (+1 image)]\n',
    );
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
