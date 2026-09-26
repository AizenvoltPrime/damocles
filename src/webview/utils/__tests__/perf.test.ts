import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { beginReplayIngest, countReplayItem, endReplayIngest } from '../perf';

let lines: string[];
let frames: FrameRequestCallback[];
let now: number;

beforeEach(() => {
  lines = [];
  frames = [];
  now = 0;
  vi.spyOn(console, 'debug').mockImplementation((line: string) => void lines.push(line));
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});
afterEach(() => {
  endReplayIngest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('replay ingest span', () => {
  it('logs nothing when the done ends a live turn rather than a replay', () => {
    beginReplayIngest();
    endReplayIngest();

    expect(lines).toEqual([]);
    expect(frames).toEqual([]);
  });

  it('restarts when a new replay begins before the previous one ended', () => {
    beginReplayIngest();
    countReplayItem();
    now = 100;
    beginReplayIngest();
    countReplayItem();
    countReplayItem();
    now = 150;
    endReplayIngest();

    expect(lines).toEqual(['[perf] replay.ingest 50.0ms items=2']);
  });

  it('logs the painted span in the task after the frame, not inside the frame callback', async () => {
    beginReplayIngest();
    countReplayItem();
    now = 40;
    endReplayIngest();
    await nextTick();

    now = 60;
    for (const cb of frames) cb(0);
    expect(lines).toEqual(['[perf] replay.ingest 40.0ms items=1']);

    now = 75;
    vi.runAllTimers();
    expect(lines).toEqual(['[perf] replay.ingest 40.0ms items=1', '[perf] replay.painted 75.0ms items=1']);
  });
});
