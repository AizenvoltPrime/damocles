import { fork, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { folderIdFor, getFolderRepoDir, getGitDir } from '../resolver';
import type { CheckpointRecord } from '../types';

const TURNS = 6;
const SESSIONS = ['proc-a', 'proc-b'] as const;

let workDir: string;
let childBundle: string;

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(tmpdir(), 'cp-cross-process-'));
  childBundle = path.join(workDir, 'checkpoint-writer-child.cjs');
  // The child runs the real engine in a plain node process, so it is bundled rather than loaded through Vitest.
  await build({
    entryPoints: [path.join(__dirname, 'fixtures', 'checkpoint-writer-child.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: childBundle,
    logLevel: 'silent',
  });
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
});

interface ChildRun {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly exited: Promise<{ code: number | null; stderr: string }>;
}

function startWriter(cwd: string, sessionId: string, resultFile: string): ChildRun {
  const sessionFile = path.join(workDir, 'sessions', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, '');
  // The child inherits this process's environment, so it resolves the same hermetic home.
  const child = fork(childBundle, [cwd, sessionId, sessionFile, String(TURNS), resultFile], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('error', reject);
  });
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.once('exit', (code) => resolve({ code, stderr }));
  });
  return { child, ready, exited };
}

describe('folder repo checkpoints across processes', { timeout: 180_000 }, () => {
  it('AC8: two processes checkpointing one folder repo at once leave it intact with both ref sets', async () => {
    const cwd = path.join(workDir, 'shared folder');
    for (let i = 0; i < 300; i++) {
      fs.mkdirSync(path.join(cwd, `d${i % 10}`), { recursive: true });
      fs.writeFileSync(path.join(cwd, `d${i % 10}`, `f${i}.txt`), `file ${i}\n`);
    }
    const results = SESSIONS.map((s) => path.join(workDir, `${s}.json`));
    const writers = SESSIONS.map((s, i) => startWriter(cwd, s, results[i]!));
    await Promise.all(writers.map((w) => w.ready));
    for (const w of writers) w.child.send('go');
    const exits = await Promise.all(writers.map((w) => w.exited));
    for (const exit of exits) expect(exit, exit.stderr).toMatchObject({ code: 0 });

    const gitDir = getGitDir(getFolderRepoDir(folderIdFor(cwd)));
    execFileSync('git', [`--git-dir=${gitDir}`, 'fsck', '--full', '--no-dangling'], { stdio: 'pipe' });
    const refs = new Map(
      execFileSync('git', [`--git-dir=${gitDir}`, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/damocles/sessions/'])
        .toString()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' ') as [string, string]),
    );
    SESSIONS.forEach((sessionId, s) => {
      const records = JSON.parse(fs.readFileSync(results[s]!, 'utf8')) as CheckpointRecord[];
      expect(records).toHaveLength(TURNS);
      records.forEach((record, i) => {
        if (record.kind !== 'checkpoint') throw new Error(`turn ${i} of ${sessionId} is not rewindable`);
        const key = `refs/damocles/sessions/${sessionId}/${sessionId}-u${i}`;
        expect(refs.get(`${key}/before`)).toBe(record.beforeCommit);
        expect(refs.get(`${key}/after`)).toBe(record.afterCommit);
        // Each turn's own file is its change; the other process's concurrent files may land in either side.
        expect(record.fileChanges.map((c) => c.path)).toContain(`${sessionId}-${i}.txt`);
      });
    });
    expect(refs.size).toBe(SESSIONS.length * TURNS * 2);
    fs.rmSync(path.dirname(gitDir), { recursive: true, force: true });
  });
});
