import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  assetSourceDirs,
  assetSources,
  getAssetSourcePrecedence,
  type AssetSourcePrecedence,
} from '../asset-sources';

const realGetConfiguration = vscode.workspace.getConfiguration;
const realIsTrusted = vscode.workspace.isTrusted;

/** Point `damocles.assetSourcePrecedence` at `value` for the duration of one test. */
function setPrecedence(value: AssetSourcePrecedence): void {
  (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
    get: (key: string, defaultValue?: unknown) =>
      key === 'assetSourcePrecedence' ? value : defaultValue,
    update: () => Promise.resolve(),
  });
}

function setTrusted(trusted: boolean): void {
  vscode.__setTrusted(trusted);
}

const WS = path.sep === '\\' ? 'C:\\ws' : '/ws';
const HOME = path.sep === '\\' ? 'C:\\home' : '/home';

function dirsFor(kind: 'skills' | 'commands', workspacePath: string | null): string[] {
  return assetSourceDirs(kind, { workspacePath, homeDir: HOME }).map((d) => d.dir);
}

describe('asset-sources', () => {
  beforeEach(() => {
    setPrecedence('claude');
    setTrusted(true);
  });

  afterEach(() => {
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = realGetConfiguration;
    vscode.__setTrusted(realIsTrusted);
  });

  describe('assetSources', () => {
    it('puts .damocles first and orders claude before codex under the claude precedence', () => {
      expect(assetSources('claude').map((s) => s.name)).toEqual(['damocles', 'claude', 'codex']);
    });

    it('keeps .damocles first and swaps only the claude/codex pair under the codex precedence', () => {
      expect(assetSources('codex').map((s) => s.name)).toEqual(['damocles', 'codex', 'claude']);
    });

    it('reads the configured precedence when none is passed', () => {
      setPrecedence('codex');
      expect(getAssetSourcePrecedence()).toBe('codex');
      expect(assetSources().map((s) => s.name)).toEqual(['damocles', 'codex', 'claude']);

      setPrecedence('claude');
      expect(assetSources().map((s) => s.name)).toEqual(['damocles', 'claude', 'codex']);
    });
  });

  describe('assetSourceDirs', () => {
    it('returns every skills candidate source-major, project before user (claude precedence)', () => {
      expect(dirsFor('skills', WS)).toEqual([
        path.join(WS, '.damocles/skills'),
        path.join(HOME, '.damocles/skills'),
        path.join(WS, '.claude/skills'),
        path.join(HOME, '.claude/skills'),
        path.join(WS, '.codex/skills'),
        path.join(HOME, '.codex/skills'),
      ]);
    });

    it('keeps the .damocles pair first and swaps the claude/codex pairs under the codex precedence', () => {
      setPrecedence('codex');
      expect(dirsFor('skills', WS)).toEqual([
        path.join(WS, '.damocles/skills'),
        path.join(HOME, '.damocles/skills'),
        path.join(WS, '.codex/skills'),
        path.join(HOME, '.codex/skills'),
        path.join(WS, '.claude/skills'),
        path.join(HOME, '.claude/skills'),
      ]);
    });

    it('tags each dir with its source and scope', () => {
      expect(assetSourceDirs('skills', { workspacePath: WS, homeDir: HOME })).toEqual([
        { dir: path.join(WS, '.damocles/skills'), source: 'damocles', scope: 'project' },
        { dir: path.join(HOME, '.damocles/skills'), source: 'damocles', scope: 'user' },
        { dir: path.join(WS, '.claude/skills'), source: 'claude', scope: 'project' },
        { dir: path.join(HOME, '.claude/skills'), source: 'claude', scope: 'user' },
        { dir: path.join(WS, '.codex/skills'), source: 'codex', scope: 'project' },
        { dir: path.join(HOME, '.codex/skills'), source: 'codex', scope: 'user' },
      ]);
    });

    // The resource loader drops untrusted project dirs while the slash-command menu keeps and badges
    // them. A trust filter here would force the menu to reconstruct what the loader discarded.
    it('applies no trust filtering of its own', () => {
      setTrusted(false);
      expect(dirsFor('skills', WS)).toEqual([
        path.join(WS, '.damocles/skills'),
        path.join(HOME, '.damocles/skills'),
        path.join(WS, '.claude/skills'),
        path.join(HOME, '.claude/skills'),
        path.join(WS, '.codex/skills'),
        path.join(HOME, '.codex/skills'),
      ]);
      expect(
        assetSourceDirs('skills', { workspacePath: WS, homeDir: HOME }).filter(
          (d) => d.scope === 'project',
        ),
      ).toHaveLength(3);
    });

    it('returns only the user dirs when workspacePath is null', () => {
      const entries = assetSourceDirs('skills', { workspacePath: null, homeDir: HOME });
      expect(entries.map((d) => d.dir)).toEqual([
        path.join(HOME, '.damocles/skills'),
        path.join(HOME, '.claude/skills'),
        path.join(HOME, '.codex/skills'),
      ]);
      expect(entries.every((d) => d.scope === 'user')).toBe(true);
    });

    it('maps codex commands to .codex/prompts while claude and damocles use commands', () => {
      expect(dirsFor('commands', WS)).toEqual([
        path.join(WS, '.damocles/commands'),
        path.join(HOME, '.damocles/commands'),
        path.join(WS, '.claude/commands'),
        path.join(HOME, '.claude/commands'),
        path.join(WS, '.codex/prompts'),
        path.join(HOME, '.codex/prompts'),
      ]);
    });
  });
});
