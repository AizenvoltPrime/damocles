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

// Files the link policy refuses, as it does on Windows for one linked onto another share; any other file it judges itself.
const refused = vi.hoisted(() => new Set<string>());
vi.mock('../../config/local-config-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/local-config-path')>();
  return {
    ...actual,
    configLinkPolicy: (bases: readonly string[]) => {
      const judged = actual.configLinkPolicy(bases);
      return (file: string): boolean => !refused.has(file) && judged(file);
    },
  };
});

import { ensurePiAgentDir } from '../agent-dir-setup';
import { installLogSink } from '../../logger';
import { installFakePlatform } from '../../../__mocks__/fake-platform';

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
    refused.clear();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads and writes no settings file pi\'s link policy refuses, makes no folder on its path, and tells the user once', () => {
    const fake = installFakePlatform();
    const agentDir = path.join(tmp, 'agent');
    const settingsPath = path.join(agentDir, 'settings.json');
    refused.add(settingsPath);

    ensurePiAgentDir(agentDir, 'streaming');
    expect(fs.existsSync(agentDir)).toBe(false);

    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(settingsPath, '{"packages":["npm:x"]}');
    fsCalls.written.length = 0;
    ensurePiAgentDir(agentDir, 'streaming');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{"packages":["npm:x"]}');
    expect(fsCalls.written).toEqual([]);
    expect(fsCalls.renamed).toEqual([]);
    expect(logLines.join('\n')).toContain(`Left ${settingsPath} unseeded: it links to a network share or WSL path`);
    expect(fake.notifications.calls.map((call) => call.text)).toEqual([{ message: '{0} links to a network share or WSL path, so Damocles does not read it.', args: [settingsPath] }]);
  });

  // pi writes through the link itself (writeFileSync), so a dotfiles setup keeps its link.
  it.for([
    ['an existing file', 'file'],
    ['a file not made yet', 'folder'],
    ['a file in a folder not made yet', 'nothing'],
  ] as const)('writes through a settings.json symlinked to %s and keeps the link', ([, made], ctx) => {
    const exists = made === 'file';
    const agentDir = path.join(tmp, 'agent');
    const settingsPath = path.join(agentDir, 'settings.json');
    const dotfile = path.join(tmp, 'dotfiles', 'pi-settings.json');
    if (made !== 'nothing') fs.mkdirSync(path.dirname(dotfile), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    if (exists) fs.writeFileSync(dotfile, JSON.stringify({ theme: 'dark' }));
    try {
      fs.symlinkSync(dotfile, settingsPath, 'file');
    } catch (err) {
      // a file symlink needs Developer Mode or an elevated process on Windows
      if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw err;
    }

    ensurePiAgentDir(agentDir, 'idle');
    expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    const seeded = JSON.parse(fs.readFileSync(dotfile, 'utf8'));
    expect(seeded).toMatchObject({ cacheWarming: 'idle', compaction: { enabled: false }, ...(exists ? { theme: 'dark' } : {}) });
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
