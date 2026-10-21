import { afterEach, describe, expect, it } from 'vitest';
import { installLogSink, installWorkerLogRelay, log } from '../logger';

const STAMP = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /;

afterEach(() => installLogSink({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }));

describe('logger', () => {
  it('stamps each line once in the host that writes the log', () => {
    const lines: string[] = [];
    installLogSink({ appendLine: (line) => lines.push(line), show: () => undefined, dispose: () => undefined });
    log('[perf] %s', 'memory.integrity');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(STAMP);
    expect(lines[0]!.replace(STAMP, '')).toBe('[perf] memory.integrity');
  });

  it('relays a worker thread\'s line unstamped, so the host\'s log() stamps a relayed line once', () => {
    const relayed: string[] = [];
    installWorkerLogRelay((message) => relayed.push(message));
    log('[perf] %s', 'memory.integrity');
    expect(relayed).toEqual(['[perf] memory.integrity']);

    const lines: string[] = [];
    installLogSink({ appendLine: (line) => lines.push(line), show: () => undefined, dispose: () => undefined });
    log(relayed[0]);
    expect(lines[0]!.replace(STAMP, '')).toBe('[perf] memory.integrity');
  });
});
