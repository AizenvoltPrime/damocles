import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Records which paths the seeder writes and renames; every call still hits the real filesystem. */
const fsCalls = vi.hoisted(() => ({ written: [] as string[], renamed: [] as Array<[string, string]> }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    fsCalls.written.push(String(file));
    actual.writeFileSync(file, data, options);
  };
  const renameSync: typeof actual.renameSync = (from, to) => {
    fsCalls.renamed.push([String(from), String(to)]);
    actual.renameSync(from, to);
  };
  return { ...actual, default: actual, writeFileSync, renameSync };
});

import { cacheWarmingSetting, ensurePiAgentDir } from '../agent-dir';
import { installLogSink } from '../../logger';

describe('ensurePiAgentDir (B3 + FR-9)', () => {
  let tmp: string;
  let logLines: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agentdir-'));
    fsCalls.written.length = 0;
    fsCalls.renamed.length = 0;
    logLines = [];
    installLogSink({ appendLine: (line) => void logLines.push(line), show: () => undefined, dispose: () => undefined });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the dir + extensions subdir and seeds compaction off / images unblocked', () => {
    const agentDir = path.join(tmp, 'agent');
    ensurePiAgentDir(agentDir, 'streaming');
    expect(fs.existsSync(path.join(agentDir, 'extensions'))).toBe(true);

    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(settings.compaction.enabled).toBe(false);
    expect(settings.images.blockImages).toBe(false);
    expect(settings.cacheWarming).toBe('streaming');
  });

  it('is idempotent — a second call does not rewrite the already-correct file', () => {
    const agentDir = path.join(tmp, 'agent');
    ensurePiAgentDir(agentDir, 'streaming');
    const first = fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8');
    fsCalls.renamed.length = 0;
    ensurePiAgentDir(agentDir, 'streaming');
    expect(fsCalls.renamed).toEqual([]);
    expect(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).toBe(first);
  });

  it.each([
    ['is not JSON', '{ "packages": ["npm:x"], ', 'it is not valid JSON'],
    ['holds an array', '[{ "packages": ["npm:x"] }]', 'it does not hold a JSON object'],
    ['holds a string', '"packages"', 'it does not hold a JSON object'],
  ])('leaves a settings file that %s as it is and logs why, without its text', (_label, text, reason) => {
    const agentDir = path.join(tmp, 'agent');
    const settingsPath = path.join(agentDir, 'settings.json');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(settingsPath, text);
    fsCalls.written.length = 0;

    ensurePiAgentDir(agentDir, 'streaming');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(text);
    expect(fsCalls.written).toEqual([]);
    expect(fsCalls.renamed).toEqual([]);
    expect(logLines.join('\n')).toContain(`Left ${settingsPath} unseeded: ${reason}`);
    expect(logLines.join('\n')).not.toContain('npm:x');
  });

  it('leaves a settings path it cannot read as it is and logs why', () => {
    const agentDir = path.join(tmp, 'agent');
    const settingsPath = path.join(agentDir, 'settings.json');
    // A folder in the file's place fails the read with EISDIR on every platform.
    fs.mkdirSync(settingsPath, { recursive: true });

    ensurePiAgentDir(agentDir, 'streaming');
    expect(fs.statSync(settingsPath).isDirectory()).toBe(true);
    expect(fsCalls.renamed).toEqual([]);
    expect(logLines.join('\n')).toContain(`Left ${settingsPath} unseeded: it cannot be read (EISDIR)`);
  });

  it('seeds an empty settings file, which pi reads as no settings', () => {
    const agentDir = path.join(tmp, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), '');

    ensurePiAgentDir(agentDir, 'idle');
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).cacheWarming).toBe('idle');
  });

  it('merges into existing settings without clobbering unrelated keys', () => {
    const agentDir = path.join(tmp, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', compaction: { reserveTokens: 999, enabled: true } }),
    );

    ensurePiAgentDir(agentDir, 'idle');

    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(settings.theme).toBe('dark');
    expect(settings.compaction.enabled).toBe(false);
    expect(settings.compaction.reserveTokens).toBe(999);
    expect(settings.images.blockImages).toBe(false);
    expect(settings.cacheWarming).toBe('idle');
  });

  it('keeps the keys of a settings file that starts with a BOM, and writes it back without one', () => {
    const agentDir = path.join(tmp, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), `\uFEFF${JSON.stringify({ packages: ['npm:x'] })}`);

    ensurePiAgentDir(agentDir, 'idle');

    const text = fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8');
    expect(text.startsWith('{')).toBe(true);
    expect(JSON.parse(text).packages).toEqual(['npm:x']);
  });

  // The short-circuit compares `cacheWarming` against the caller's value, unlike the two keys that are
  // compared against constants. A mode change must therefore still rewrite an otherwise-correct file.
  it('rewrites cacheWarming when the configured mode changed, keeping the other seeded keys', () => {
    const agentDir = path.join(tmp, 'agent');
    ensurePiAgentDir(agentDir, 'streaming');
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).cacheWarming).toBe('streaming');

    ensurePiAgentDir(agentDir, 'off');

    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(settings.cacheWarming).toBe('off');
    expect(settings.compaction.enabled).toBe(false);
    expect(settings.images.blockImages).toBe(false);
  });

  // pi takes a lock on this file and stops persisting global settings for the whole session if it ever
  // reads a truncated one, so the target must only ever appear complete.
  it('publishes the file by renaming a temp file rather than writing the target in place', () => {
    const agentDir = path.join(tmp, 'agent');
    const settingsPath = path.join(agentDir, 'settings.json');
    ensurePiAgentDir(agentDir, 'idle');

    expect(fsCalls.written).not.toContain(settingsPath);
    expect(fsCalls.renamed).toContainEqual([expect.stringContaining(`${settingsPath}.`), settingsPath]);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).cacheWarming).toBe('idle');
  });
});

describe('cacheWarmingSetting', () => {
  // pi coerces an unknown mode to "streaming"; the extension must seed the same value rather than a
  // mode pi will silently ignore.
  it('falls back to streaming when damocles.cacheWarming is unset', () => {
    expect(cacheWarmingSetting()).toBe('streaming');
  });
});
