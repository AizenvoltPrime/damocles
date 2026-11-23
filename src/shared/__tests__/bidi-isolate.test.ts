import { describe, expect, it } from 'vitest';
import { isolated, isolatedParts, withoutIsolates } from '../bidi-isolate';

const NAME = 'ליל 2';

describe('isolated user text', () => {
  it('splits a sentence into its plain runs and its marked names, in order', () => {
    const sentence = `Applied ${isolated(NAME)} (was ${isolated('Night')}).`;
    expect(isolatedParts(sentence)).toEqual([
      { text: 'Applied ', isolated: false },
      { text: NAME, isolated: true },
      { text: ' (was ', isolated: false },
      { text: 'Night', isolated: true },
      { text: ').', isolated: false },
    ]);
    expect(withoutIsolates(sentence)).toBe(`Applied ${NAME} (was Night).`);
  });

  it('reads a sentence with no mark as one plain run, an empty one as none, and a name alone as one marked run', () => {
    expect(isolatedParts('Nothing to mark')).toEqual([{ text: 'Nothing to mark', isolated: false }]);
    expect(isolatedParts('')).toEqual([]);
    expect(isolatedParts(isolated(NAME))).toEqual([{ text: NAME, isolated: true }]);
  });

  it('keeps one run for a name that holds marks of its own, and drops a mark with no partner', () => {
    expect(isolatedParts(isolated(`a\u2069b\u2068c`))).toEqual([{ text: 'abc', isolated: true }]);
    expect(isolatedParts(`open \u2068never closed`)).toEqual([{ text: 'open never closed', isolated: false }]);
    expect(isolatedParts(`stray \u2069 close`)).toEqual([{ text: 'stray  close', isolated: false }]);
  });
});
