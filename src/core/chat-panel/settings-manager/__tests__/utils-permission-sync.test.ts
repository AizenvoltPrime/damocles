import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-perm-write-'));
  return {
    tmpRoot: root,
    fakeHome: nodePath.join(root, 'home'),
    fakeWorkspace: nodePath.join(root, 'workspace'),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

import type { PermissionUpdate } from '../../../../shared/types/permissions';
import { syncPermissionRulesToSettings } from '../utils';

const addPushRule = (destination: PermissionUpdate['destination']): PermissionUpdate => ({
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }],
  behavior: 'allow',
  destination,
});

/** A timestamp far enough in the past that any rewrite would visibly move the file's mtime. */
const OLD_MTIME = new Date('2020-01-01T00:00:00Z');

beforeEach(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(fakeWorkspace, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('syncPermissionRulesToSettings', () => {
  it('writes a localSettings rule to <workspace>/.damocles/settings.local.json, creating the directory', async () => {
    await syncPermissionRulesToSettings([addPushRule('localSettings')], fakeWorkspace);

    const written = path.join(fakeWorkspace, '.damocles', 'settings.local.json');
    expect(JSON.parse(fs.readFileSync(written, 'utf-8'))).toEqual({
      permissions: { allow: ['Bash(git push:*)'] },
    });
  });

  it('falls back to ~/.damocles/settings.local.json when there is no workspace', async () => {
    await syncPermissionRulesToSettings([addPushRule('localSettings')], null);

    const written = path.join(fakeHome, '.damocles', 'settings.local.json');
    expect(JSON.parse(fs.readFileSync(written, 'utf-8')).permissions.allow).toEqual(['Bash(git push:*)']);
  });

  // Unreachable today (approval-manager only ever emits 'localSettings'), but these two branches were
  // repointed to .damocles by this change, so their resolved paths are pinned here.
  it('writes a projectSettings rule to <workspace>/.damocles/settings.json', async () => {
    await syncPermissionRulesToSettings([addPushRule('projectSettings')], fakeWorkspace);

    const written = path.join(fakeWorkspace, '.damocles', 'settings.json');
    expect(JSON.parse(fs.readFileSync(written, 'utf-8')).permissions.allow).toEqual(['Bash(git push:*)']);
  });

  it('writes a userSettings rule to ~/.damocles/settings.json', async () => {
    await syncPermissionRulesToSettings([addPushRule('userSettings')], fakeWorkspace);

    const written = path.join(fakeHome, '.damocles', 'settings.json');
    expect(JSON.parse(fs.readFileSync(written, 'utf-8')).permissions.allow).toEqual(['Bash(git push:*)']);
  });

  it('writes nothing at all for a session-scoped rule', async () => {
    await syncPermissionRulesToSettings([addPushRule('session')], fakeWorkspace);

    expect(fs.existsSync(fakeWorkspace)).toBe(false);
    expect(fs.existsSync(fakeHome)).toBe(false);
  });

  it('leaves a pre-existing .claude settings file untouched, verified by mtime', async () => {
    const clauded = path.join(fakeWorkspace, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(clauded), { recursive: true });
    fs.writeFileSync(clauded, JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }), 'utf-8');
    fs.utimesSync(clauded, OLD_MTIME, OLD_MTIME);
    const before = fs.statSync(clauded).mtimeMs;
    expect(before).toBe(OLD_MTIME.getTime());

    await syncPermissionRulesToSettings([addPushRule('localSettings')], fakeWorkspace);

    // The .damocles write really happened, so an unchanged .claude mtime is not a vacuous pass.
    expect(fs.existsSync(path.join(fakeWorkspace, '.damocles', 'settings.local.json'))).toBe(true);
    expect(fs.statSync(clauded).mtimeMs).toBe(before);
  });
});

describe('syncPermissionRulesToSettings — hostile and malformed input', () => {
  const localPath = path.join(fakeWorkspace, '.damocles', 'settings.local.json');

  function writeRaw(content: string): void {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, content, 'utf-8');
  }

  it('ignores a behavior outside allow/deny/ask instead of writing it as a key', async () => {
    // `behavior` indexes an object and arrives off a webview message: `__proto__` would write the
    // prototype rather than a key, and `constructor` would leave junk in the user's settings.
    const hostile = { ...addPushRule('localSettings'), behavior: '__proto__' } as unknown as PermissionUpdate;

    await syncPermissionRulesToSettings([hostile], fakeWorkspace);

    expect(fs.existsSync(localPath)).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('refuses to overwrite a settings file holding a top-level null, and reports it', async () => {
    writeRaw('null');

    const failures = await syncPermissionRulesToSettings([addPushRule('localSettings')], fakeWorkspace);

    expect(fs.readFileSync(localPath, 'utf-8')).toBe('null');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`${localPath} does not parse, so it was not overwritten`);
  });

  // The file also holds every other setting; rewriting it from an empty object would lose them all.
  it('refuses to overwrite a settings file that does not parse, and reports it', async () => {
    const text = '{ "permissions": { "allow": [] }, "damocles.model": "x", }';
    writeRaw(text);

    const failures = await syncPermissionRulesToSettings([addPushRule('localSettings')], fakeWorkspace);

    expect(fs.readFileSync(localPath, 'utf-8')).toBe(text);
    expect(failures).toEqual([expect.stringContaining('The permission rule was not saved.')]);
  });

  it('writes into a settings file that starts with a BOM', async () => {
    writeRaw('\uFEFF{ "damocles.model": "x" }');

    expect(await syncPermissionRulesToSettings([addPushRule('localSettings')], fakeWorkspace)).toEqual([]);

    expect(JSON.parse(fs.readFileSync(localPath, 'utf-8'))).toEqual({ 'damocles.model': 'x', permissions: { allow: ['Bash(git push:*)'] } });
  });

  it('refuses a project file a symlink points at another tool\'s settings', async () => {
    const claudeFile = path.join(fakeWorkspace, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.writeFileSync(claudeFile, '{}');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.symlinkSync(claudeFile, localPath, 'file');

    const failures = await syncPermissionRulesToSettings([addPushRule('localSettings')], fakeWorkspace);

    expect(fs.readFileSync(claudeFile, 'utf-8')).toBe('{}');
    expect(failures).toHaveLength(1);
  });

  it('keeps writing the remaining updates after one destination fails', async () => {
    // A directory where the file should be makes the first write fail; the second must still land, or
    // one bad destination silently abandons every rule queued behind it.
    const globalPath = path.join(fakeHome, '.damocles', 'settings.json');
    fs.mkdirSync(globalPath, { recursive: true });

    await syncPermissionRulesToSettings(
      [addPushRule('userSettings'), addPushRule('localSettings')],
      fakeWorkspace,
    );

    expect(JSON.parse(fs.readFileSync(localPath, 'utf-8')).permissions.allow).toEqual(['Bash(git push:*)']);
  });

  it('ends the file with a newline', async () => {
    await syncPermissionRulesToSettings([addPushRule('localSettings')], fakeWorkspace);

    expect(fs.readFileSync(localPath, 'utf-8').endsWith('}\n')).toBe(true);
  });
});
