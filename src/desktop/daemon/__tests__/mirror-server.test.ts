import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { piSessionDir } from '../../../core/pi-session/session-store/session-dir';
import type { MirrorFile } from '../control-messages';
import { HASH_SPAN_BYTES, syncMirror, type MirrorStream } from '../mirror-server';

let agentDir: string;
let project: string;
let sessions: string;
let streams: Map<number, { bytes: Buffer[]; ended: boolean }>;
let nextId: number;

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function held(file: string, bytes: Buffer): MirrorFile {
  return { file, size: bytes.length, headHash: sha(bytes.subarray(0, HASH_SPAN_BYTES)), tailHash: sha(bytes.subarray(Math.max(0, bytes.length - HASH_SPAN_BYTES))) };
}

function write(relative: string, text: string, mtimeMs: number): void {
  const file = path.join(sessions, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

const deps = () => ({
  agentDir,
  log: () => undefined,
  reserveStream: () => (nextId += 2),
  drained: () => Promise.resolve(),
  openStream: (id: number): MirrorStream => {
    const record = { bytes: [] as Buffer[], ended: false };
    streams.set(id, record);
    return { id, closed: false, write: (bytes) => { record.bytes.push(Buffer.from(bytes)); return true; }, end: () => { record.ended = true; }, onDrain: () => undefined };
  },
});

// the streams open after the answer, from an immediate
async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  for (let tries = 0; tries < 100 && [...streams.values()].some((stream) => !stream.ended); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-agent-'));
  project = path.join(os.tmpdir(), 'srv', 'app');
  sessions = piSessionDir(project, agentDir);
  streams = new Map();
  nextId = 15;
});

describe('mirror.sync on the daemon', () => {
  it('sends a file the client lacks whole, and only the appended bytes of one whose head and tail match', async () => {
    write('a.jsonl', 'line one\nline two\n', 2000);
    write('a/subagents/agent-1.jsonl', 'agent\n', 1000);
    const before = Buffer.from('line one\n');
    const { changes } = await syncMirror(deps(), { projectKey: project, budgetBytes: 1 << 20, files: [held('a.jsonl', before)] });
    await settled();
    expect(changes).toEqual([
      { file: 'a.jsonl', kind: 'append', offset: before.length, length: 9, stream: 17 },
      { file: 'a/subagents/agent-1.jsonl', kind: 'full', offset: 0, length: 6, stream: 19 },
    ]);
    expect(Buffer.concat(streams.get(17)!.bytes).toString()).toBe('line two\n');
    expect(Buffer.concat(streams.get(19)!.bytes).toString()).toBe('agent\n');
  });

  it('resyncs the whole file when its head changed, as after pi rewrites it', async () => {
    write('a.jsonl', 'REWRITTEN\nline two\n', 2000);
    const { changes } = await syncMirror(deps(), { projectKey: project, budgetBytes: 1 << 20, files: [held('a.jsonl', Buffer.from('line one\n'))] });
    await settled();
    expect(changes).toEqual([{ file: 'a.jsonl', kind: 'full', offset: 0, length: 19, stream: 17 }]);
  });

  it('sends nothing for a file the client holds whole', async () => {
    write('a.jsonl', 'same\n', 2000);
    expect(await syncMirror(deps(), { projectKey: project, budgetBytes: 1 << 20, files: [held('a.jsonl', Buffer.from('same\n'))] })).toEqual({ changes: [] });
  });

  it('stops sending once the connection closes under a writer waiting for its drain', async () => {
    write('big.jsonl', 'x'.repeat(3 * 256 * 1024), 2000);
    let drain: (() => void) | undefined;
    let ended = false;
    const stream = { id: 17, closed: false, write: () => false, end: () => { ended = true; }, onDrain: (listener: () => void) => { drain = listener; } };
    await syncMirror({ ...deps(), openStream: () => stream }, { projectKey: project, budgetBytes: 1 << 20, files: [] });
    await vi.waitFor(() => expect(drain).toBeDefined());
    // what the mux does as it is disposed
    stream.closed = true;
    drain!();
    await vi.waitFor(() => expect(ended).toBe(true));
  });

  it('deletes what the client holds outside the newest files that fit the budget, and names no path of its own', async () => {
    write('new.jsonl', 'n'.repeat(100), 3000);
    write('old.jsonl', 'o'.repeat(100), 1000);
    const { changes } = await syncMirror(deps(), {
      projectKey: project,
      budgetBytes: 150,
      files: [held('old.jsonl', Buffer.from('o'.repeat(100))), held('gone.jsonl', Buffer.from('x')), held('../../etc/passwd', Buffer.from('x'))],
    });
    await settled();
    expect(changes).toEqual([
      { file: 'new.jsonl', kind: 'full', offset: 0, length: 100, stream: 17 },
      { file: 'old.jsonl', kind: 'deleted', offset: 0, length: 0, stream: 0 },
      { file: 'gone.jsonl', kind: 'deleted', offset: 0, length: 0, stream: 0 },
      { file: '../../etc/passwd', kind: 'deleted', offset: 0, length: 0, stream: 0 },
    ]);
  });
});
