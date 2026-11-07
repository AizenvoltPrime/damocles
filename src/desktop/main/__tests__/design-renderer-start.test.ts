import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { rendererEnvironment } from '../design/design-renderer-protocol';
import { processEnded, removeOrphanFolders } from '../design/design-renderer-start';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

describe('the design renderer process end', () => {
  const settled = async (ended: Promise<string>): Promise<string | undefined> => Promise.race([ended, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10))]);

  it('ends at a start error, and only at the exit once the process started, so its folder is removed after the exit', async () => {
    const failed = new EventEmitter();
    const failedEnd = processEnded(failed as unknown as ChildProcess);
    failed.emit('error', new Error('spawn ENOENT'));
    expect(await settled(failedEnd)).toBe('it could not start: spawn ENOENT');

    const running = new EventEmitter();
    const runningEnd = processEnded(running as unknown as ChildProcess);
    running.emit('spawn');
    running.emit('error', new Error('kill EPERM'));
    expect(await settled(runningEnd)).toBeUndefined();
    running.emit('exit', 0, null);
    expect(await settled(runningEnd)).toBe('exit code 0');
  });
});

describe('the design renderer environment', () => {
  it('passes only what Electron and the OS need, never a key or token of main', () => {
    const env = { SystemRoot: 'C:/Windows', Path: 'C:/Windows', TEMP: 'C:/T', LOCALAPPDATA: 'C:/L', OPENAI_API_KEY: 'sk-1', GITHUB_TOKEN: 'ghp', ANTHROPIC_API_KEY: 'k', DAMOCLES_E2E: '1' };
    expect(rendererEnvironment(env, 'win32')).toEqual({ SystemRoot: 'C:/Windows', Path: 'C:/Windows', TEMP: 'C:/T', LOCALAPPDATA: 'C:/L' });
    const posix = { HOME: '/home/u', PATH: '/usr/bin', DISPLAY: ':0', LC_ALL: 'el_GR.UTF-8', XDG_RUNTIME_DIR: '/run/user/1000', AWS_SECRET_ACCESS_KEY: 's', SSH_AUTH_SOCK: '/tmp/agent' };
    expect(rendererEnvironment(posix, 'linux')).toEqual({ HOME: '/home/u', PATH: '/usr/bin', DISPLAY: ':0', LC_ALL: 'el_GR.UTF-8', XDG_RUNTIME_DIR: '/run/user/1000' });
    expect(rendererEnvironment(posix, 'darwin')).toEqual({ HOME: '/home/u', PATH: '/usr/bin', LC_ALL: 'el_GR.UTF-8' });
  });
});

describe('left design renderer folders', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const folder of made.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  it('removes the folders of a main that is gone and keeps a live main\'s, this one\'s included', async () => {
    const dead = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-design-renderer-999999999-'));
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), `damocles-design-renderer-${process.pid}-`));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-design-renderer-x-'));
    made.push(dead, mine, other);
    fs.writeFileSync(path.join(dead, 'Local State'), '{}');
    await removeOrphanFolders(() => undefined);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(mine)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('retries the folder of an ended renderer of this main whose removal failed, and forgets it once removed', async () => {
    const ended = fs.mkdtempSync(path.join(os.tmpdir(), `damocles-design-renderer-${process.pid}-`));
    const running = fs.mkdtempSync(path.join(os.tmpdir(), `damocles-design-renderer-${process.pid}-`));
    made.push(ended, running);
    fs.writeFileSync(path.join(ended, 'Local State'), '{}');
    const left = new Set([ended]);
    await removeOrphanFolders(() => undefined, left);
    expect(fs.existsSync(ended)).toBe(false);
    expect(fs.existsSync(running)).toBe(true);
    expect(left.size).toBe(0);
  });
});
