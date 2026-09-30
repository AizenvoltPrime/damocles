import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLogSink } from '../../logger';
import { readAuthFile } from '../auth-file';
import { readClaudeAuthFromDisk } from '../subscription';
import { readOpenAIAuthFromDisk } from '../openai-auth';

// pi's `exports` map has no require condition, so the package dir is found by Node's lookup paths instead.
const piDir = createRequire(__filename).resolve.paths('@earendil-works/pi-coding-agent')!
  .map((dir) => path.join(dir, '@earendil-works', 'pi-coding-agent'))
  .find((dir) => fs.existsSync(path.join(dir, 'package.json')))!;
const piAuthStorageUrl = pathToFileURL(path.join(piDir, 'dist', 'core', 'auth-storage.js')).href;

let agentDir: string;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-auth-file-'));
});

afterEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 3 });
});

const authPath = (): string => path.join(agentDir, 'auth.json');

describe('readAuthFile', () => {
  it('reads nothing when the agent dir or the file does not exist, and creates neither', () => {
    expect(readAuthFile(path.join(agentDir, 'missing'))).toBeUndefined();
    expect(fs.existsSync(path.join(agentDir, 'missing'))).toBe(false);
    expect(readAuthFile(agentDir)).toBeUndefined();
    expect(fs.readdirSync(agentDir)).toEqual([]);
  });

  it('parses the file, BOM included, and takes no lock', () => {
    fs.writeFileSync(authPath(), '\uFEFF{"anthropic":{"type":"api_key"}}');
    expect(readAuthFile(agentDir)).toEqual({ anthropic: { type: 'api_key' } });
    expect(fs.readdirSync(agentDir)).toEqual(['auth.json']);
  });

  // pi's writers retry only ELOCKED, so a reader that locked could fail pi's write on Windows (EPERM).
  it('reads while pi holds its lock, and leaves the lock alone', () => {
    fs.writeFileSync(authPath(), '{"openai":{"type":"api_key"}}');
    const release = lockfile.lockSync(authPath(), { realpath: false });
    try {
      expect(readAuthFile(agentDir)).toEqual({ openai: { type: 'api_key' } });
      expect(lockfile.checkSync(authPath(), { realpath: false })).toBe(true);
    } finally {
      release();
    }
  });

  it('returns the last content it parsed while the file reads as pi mid-write, and throws when it has none', () => {
    fs.writeFileSync(authPath(), '');
    expect(() => readAuthFile(agentDir)).toThrow(SyntaxError);

    fs.writeFileSync(authPath(), '{"openai":{"type":"api_key"}}');
    expect(readAuthFile(agentDir)).toEqual({ openai: { type: 'api_key' } });
    for (const torn of ['', '{"openai":{"ty']) {
      fs.writeFileSync(authPath(), torn);
      expect(readAuthFile(agentDir)).toEqual({ openai: { type: 'api_key' } });
    }
  });

  it('retries a broken file once per distinct text, so a file that stays broken costs no further sleeps', () => {
    const sleeps = vi.spyOn(Atomics, 'wait');
    fs.writeFileSync(authPath(), '{"openai":{"type":"api_key"}}');
    readAuthFile(agentDir);
    fs.writeFileSync(authPath(), '{"openai":');
    readAuthFile(agentDir);
    expect(sleeps).toHaveBeenCalledTimes(4);
    readAuthFile(agentDir);
    readAuthFile(agentDir);
    expect(sleeps).toHaveBeenCalledTimes(4);
    fs.writeFileSync(authPath(), '{"openai":{');
    readAuthFile(agentDir);
    expect(sleeps).toHaveBeenCalledTimes(8);
    sleeps.mockRestore();
  });

  it('keeps both status readers signed in while the file reads as pi mid-write', () => {
    fs.writeFileSync(authPath(), '{"anthropic":{"type":"api_key"},"openai":{"type":"api_key"}}');
    expect(readClaudeAuthFromDisk(agentDir)).toEqual({ mode: 'apikey' });
    fs.writeFileSync(authPath(), '');
    expect(readClaudeAuthFromDisk(agentDir)).toEqual({ mode: 'apikey' });
    expect(readOpenAIAuthFromDisk(agentDir)).toEqual({ apiKey: true, codex: false });
  });

  it('throws on a corrupt file, which the status readers show as signed out', () => {
    fs.writeFileSync(authPath(), '{"anthropic":');
    expect(() => readAuthFile(agentDir)).toThrow(SyntaxError);
    expect(readClaudeAuthFromDisk(agentDir)).toEqual({ mode: 'none' });
    expect(readOpenAIAuthFromDisk(agentDir)).toEqual({ apiKey: false, codex: false });
  });

  // A JSON.parse message quotes the text it failed on, and auth.json holds tokens.
  it('logs a corrupt file by error name only, once until the file reads again', () => {
    const lines: string[] = [];
    installLogSink({ appendLine: (line) => lines.push(line), show: () => undefined, dispose: () => undefined });
    const healthyDir = path.join(agentDir, 'healthy');
    fs.mkdirSync(healthyDir);
    fs.writeFileSync(path.join(healthyDir, 'auth.json'), '{}');
    try {
      readClaudeAuthFromDisk(healthyDir);
      fs.writeFileSync(authPath(), '{"anthropic":{"type":"oauth","access":"sk-ant-secret-token"');
      for (let i = 0; i < 3; i++) readClaudeAuthFromDisk(agentDir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('auth.json unreadable (SyntaxError)');
      expect(lines.join('\n')).not.toContain('sk-ant-secret-token');

      readClaudeAuthFromDisk(healthyDir);
      readClaudeAuthFromDisk(agentDir);
      expect(lines).toHaveLength(2);
    } finally {
      installLogSink({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() });
    }
  });

  it('never fails pi\'s writer and never returns a partial file while pi rewrites it from another process', async () => {
    // pi's writer creates a missing file as `{}` without the lock, which is not one of the loop's documents.
    fs.writeFileSync(authPath(), '{"marker":"a"}');
    expect(readAuthFile(agentDir)).toEqual({ marker: 'a' });
    const child = fork(path.join(__dirname, 'fixtures', 'pi-auth-writer-child.mjs'), [authPath(), piAuthStorageUrl], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const messages: unknown[] = [];
    child.on('message', (message) => messages.push(message));
    await expect(new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('exit', (code) => reject(new Error(`writer exited ${code}: ${stderr}`)));
    })).resolves.toBeUndefined();

    const markers = new Set<unknown>();
    let reads = 0;
    try {
      for (const deadline = Date.now() + 1_500; Date.now() < deadline; reads++) {
        markers.add(readAuthFile(agentDir)?.['marker']);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
    } finally {
      child.send('stop');
    }
    const code = await exited;
    expect(code, stderr).toBe(0);

    const writes = (messages.at(-1) as { writes: number }).writes;
    expect(writes).toBeGreaterThan(20);
    expect(reads).toBeGreaterThan(20);
    expect([...markers].every((m) => m === 'a' || m === 'b')).toBe(true);
  }, 20_000);
});
