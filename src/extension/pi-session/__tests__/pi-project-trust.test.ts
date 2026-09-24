import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import * as vscode from 'vscode';
import { __setTrusted, __trustEmitter } from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { PiRuntime } from '../pi-runtime';
import { initPiLoader } from '../pi-loader';

/**
 * pi's project layer can run repository code: `.pi/extensions/*` is imported and executed before
 * Damocles' `extensionsOverride` filter sees it, and `.pi/settings.json` supplies the shell. In a
 * restricted window none of it may load, for panels and subagents alike, and a trust grant loads it
 * with no window reload. The probe extension writes a marker file the moment pi runs it.
 */
describe('pi project layer follows workspace trust', () => {
  const made: string[] = [];
  const sessions: AgentSession[] = [];

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  beforeAll(async () => {
    vi.spyOn(vscode.window, 'createOutputChannel').mockReturnValue({
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    } as unknown as vscode.LogOutputChannel);
    // The cold import of pi takes seconds under parallel load; pay it once, outside any test's budget.
    if (!(await initPiLoader())) throw new Error('pi failed to load');
  }, 60_000);

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.dispose();
    await PiRuntime.disposeInstance();
    __setTrusted(true);
    __trustEmitter.clear();
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function probeProject(): { project: string; marker: string } {
    const project = tempDir('damocles-trust-ws-');
    const marker = path.join(tempDir('damocles-trust-marker-'), 'loaded');
    fs.mkdirSync(path.join(project, '.pi', 'extensions'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.pi', 'extensions', 'probe.ts'),
      `import { writeFileSync } from 'node:fs';\nexport default function () { writeFileSync(${JSON.stringify(marker)}, 'loaded'); }\n`,
    );
    fs.writeFileSync(path.join(project, '.pi', 'settings.json'), JSON.stringify({ shellPath: '/probe/shell' }));
    return { project, marker };
  }

  it('a trusted window runs the project extension and reads its shell (probe sanity)', async () => {
    const { project, marker } = probeProject();
    const folder = await PiRuntime.get(tempDir('damocles-trust-agent-')).folder(project);

    expect(fs.existsSync(marker)).toBe(true);
    expect(folder.services.settingsManager.getShellPath()).toBe('/probe/shell');
  }, 60_000);

  it('a restricted window loads none of it in any folder, and a trust grant loads it in every folder with no reload', async () => {
    const a = probeProject();
    const b = probeProject();
    __setTrusted(false);
    const runtime = PiRuntime.get(tempDir('damocles-trust-agent-'));
    const folderA = await runtime.folder(a.project);
    const folderB = await runtime.folder(b.project);

    for (const [folder, { marker }] of [[folderA, a], [folderB, b]] as const) {
      expect(fs.existsSync(marker)).toBe(false);
      expect(folder.services.settingsManager.getShellPath()).toBeUndefined();
    }

    __setTrusted(true);
    __trustEmitter.fire();

    for (const [folder, { marker }] of [[folderA, a], [folderB, b]] as const) {
      await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), { timeout: 10_000 });
      expect(folder.services.settingsManager.getShellPath()).toBe('/probe/shell');
    }
  }, 60_000);

  it('a subagent spawned in a restricted window does not run the project extension', async () => {
    const { project, marker } = probeProject();
    __setTrusted(false);
    const folder = await PiRuntime.get(tempDir('damocles-trust-agent-')).folder(tempDir('damocles-trust-primary-'));

    const subagent = await folder.createSubagentSession({
      cwd: project,
      systemPrompt: 'probe',
      tools: ['read'],
      customTools: [],
      extensionFactory: () => {},
      store: { kind: 'memory' },
    });
    sessions.push(subagent);

    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);
});
