import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A daemon's core: os.homedir() is the target's home (machine scope); the client's user rules arrive in clientUser.
const { tmpRoot, targetHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-perm-layers-')));
  return { tmpRoot: root, targetHome: nodePath.join(root, 'target-home') };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => targetHome;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { syncPermissionRulesToSettings } from '../../chat-panel/settings-manager/utils';
import { EvaluatorManager } from '../managers/evaluator-manager';
import { PermissionState } from '../state';
import { PermissionHandler } from '../index';
import { runPinnedTurn } from '../../client-snapshots';
import type { PermissionRuleLists } from '../../../shared/remote-user';

const ws = path.join(tmpRoot, 'app');
const clientHome = path.join(tmpRoot, 'client-home');
const evaluators: EvaluatorManager[] = [];

function targetFile(dir: '.claude' | '.damocles', permissions: Partial<PermissionRuleLists>): void {
  const file = path.join(targetHome, dir, 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions }));
}

function remoteEvaluator(clientRules: readonly PermissionRuleLists[], allowBypass = false) {
  const host = createFakeRemoteHost();
  host.set('clientUser', 'client-a', { settings: {}, permissionRules: clientRules });
  host.set('clientPolicy', 'client-a', { voice: true, allowBypass });
  const state = new PermissionState();
  state.cwd = ws;
  const evaluator = new EvaluatorManager(state, { ...createFakePlatform(), remote: host.remote });
  evaluators.push(evaluator);
  return { host, evaluator, state };
}

const lists = (partial: Partial<PermissionRuleLists>): PermissionRuleLists => ({ allow: [], ask: [], deny: [], dir: '.damocles', ...partial });

beforeEach(() => {
  fs.rmSync(targetHome, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
});

afterEach(() => {
  for (const evaluator of evaluators.splice(0)) evaluator.dispose();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('permission layers on a daemon\'s core', () => {
  it('a client deny blocks the call, and an allow in the target\'s ~/.claude/settings.json does not lift it', async () => {
    targetFile('.claude', { allow: ['Bash(git push)'] });
    const { evaluator } = remoteEvaluator([lists({ deny: ['Bash(git push)'] })]);
    expect(await evaluator.matchRule('Bash', { command: 'git push' }, ws)).toBe('deny');
  });

  it('combines deny > ask > allow across client and target files', async () => {
    targetFile('.damocles', { allow: ['Bash(npm test)'], deny: ['Bash(npm publish)'] });
    const { evaluator } = remoteEvaluator([lists({ ask: ['Bash(npm test)'], allow: ['Bash(npm publish)', 'Bash(ls)'] })]);
    expect(await evaluator.matchRule('Bash', { command: 'npm test' }, ws)).toBe('ask');
    expect(await evaluator.matchRule('Bash', { command: 'npm publish' }, ws)).toBe('deny');
    expect(await evaluator.matchRule('Bash', { command: 'ls' }, ws)).toBe('allow');
  });

  it('anchors a client file\'s /path rule at this host\'s folder of the same name', async () => {
    const { evaluator } = remoteEvaluator([lists({ dir: '.claude', deny: ['Read(/secrets/**)'] }), lists({ dir: '.damocles', deny: ['Read(/keys/**)'] })]);
    expect(await evaluator.matchRule('Read', { file_path: path.join(targetHome, '.claude', 'secrets', 'a') }, ws)).toBe('deny');
    expect(await evaluator.matchRule('Read', { file_path: path.join(targetHome, '.damocles', 'secrets', 'a') }, ws)).toBeNull();
    expect(await evaluator.matchRule('Read', { file_path: path.join(targetHome, '.damocles', 'keys', 'a') }, ws)).toBe('deny');
  });

  it('a ! carve-out in one client file never lifts another client file\'s deny', async () => {
    const { evaluator } = remoteEvaluator([lists({ deny: ['Read(**/*.env)'] }), lists({ deny: ['Read(**/*.local)', 'Read(!**/public.env)'] })]);
    expect(await evaluator.matchRule('Read', { file_path: path.join(ws, 'public.env') }, ws)).toBe('deny');
  });

  it('reads a rule saved to the machine file at the next call, without waiting for the cache to age', async () => {
    const { evaluator } = remoteEvaluator([]);
    expect(await evaluator.matchRule('Bash', { command: 'make' }, ws)).toBeNull();
    targetFile('.damocles', { allow: ['Bash(make)'] });
    evaluator.savingRules(Promise.resolve());
    expect(await evaluator.matchRule('Bash', { command: 'make' }, ws)).toBe('allow');
  });

  it('a call checked while "Always allow" is still writing its rule waits for the write and runs unasked', async () => {
    const { evaluator } = remoteEvaluator([]);
    expect(await evaluator.matchRule('Bash', { command: 'make' }, ws)).toBeNull();
    let finish!: () => void;
    const written = new Promise<void>((resolve) => (finish = resolve)).then(() => targetFile('.damocles', { allow: ['Bash(make)'] }));
    evaluator.savingRules(written);
    const decision = evaluator.matchRule('Bash', { command: 'make' }, ws);
    finish();
    expect(await decision).toBe('allow');
  });

  it('keeps the rules it read for its cache window when the client sent no user rules', async () => {
    const host = createFakeRemoteHost();
    const state = new PermissionState();
    state.cwd = ws;
    const evaluator = new EvaluatorManager(state, { ...createFakePlatform(), remote: host.remote });
    evaluators.push(evaluator);
    expect(await evaluator.matchRule('Bash', { command: 'make' }, ws)).toBeNull();
    targetFile('.damocles', { allow: ['Bash(make)'] });
    expect(await evaluator.matchRule('Bash', { command: 'make' }, ws)).toBeNull();
  });

  it('a turn reads the rules of the client it pinned', async () => {
    const { host, evaluator } = remoteEvaluator([lists({ deny: ['Bash(git push)'] })]);
    host.set('clientUser', 'client-b', { settings: {}, permissionRules: [] });
    const decision = await runPinnedTurn(host.remote, 'p1', async () => {
      host.setActing('client-b');
      return evaluator.matchRule('Bash', { command: 'git push' }, ws);
    });
    expect(decision).toBe('deny');
    expect(await evaluator.matchRule('Bash', { command: 'git push' }, ws)).toBeNull();
  });

  it('saves "Always allow" for all projects at machine scope: the target\'s ~/.damocles/settings.json, never the client\'s', async () => {
    fs.mkdirSync(path.join(clientHome, '.damocles'), { recursive: true });
    const clientFile = path.join(clientHome, '.damocles', 'settings.json');
    fs.writeFileSync(clientFile, '{}\n');
    const failures = await syncPermissionRulesToSettings([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'make:*' }], behavior: 'allow', destination: 'userSettings' }], ws);
    expect(failures).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(targetHome, '.damocles', 'settings.json'), 'utf8'))).toEqual({ permissions: { allow: ['Bash(make:*)'] } });
    expect(fs.readFileSync(clientFile, 'utf8')).toBe('{}\n');
  });
});

describe('YOLO on a daemon\'s core while the policy refuses it', () => {
  const remotePlatform = (settings: Record<string, unknown>, allowBypass: boolean) => {
    const host = createFakeRemoteHost();
    host.set('clientPolicy', 'client-a', { voice: true, allowBypass });
    return { ...createFakePlatform({ settings: { project: settings } }), remote: host.remote };
  };

  it('a settings file that turns it on (the target\'s machine file or a trusted project file) is refused', () => {
    const handler = new PermissionHandler(remotePlatform({ 'damocles.dangerouslySkipPermissions': true }, false));
    expect(handler.getDangerouslySkipPermissions()).toBe(false);
    handler.resetForNewConversation(undefined);
    expect(handler.getPermissions().dangerouslySkipPermissions).toBe(false);
  });

  it('the setter refuses turning it on and still turns it off', () => {
    const handler = new PermissionHandler(remotePlatform({}, false));
    expect(handler.setDangerouslySkipPermissions(true)).toBe(false);
    expect(handler.getDangerouslySkipPermissions()).toBe(false);
    expect(handler.setDangerouslySkipPermissions(false)).toBe(true);
  });

  it('applies where the policy allows it, and on this computer\'s core', () => {
    expect(new PermissionHandler(remotePlatform({ 'damocles.dangerouslySkipPermissions': true }, true)).getDangerouslySkipPermissions()).toBe(true);
    expect(new PermissionHandler(createFakePlatform({ settings: { user: { 'damocles.dangerouslySkipPermissions': true } } })).getDangerouslySkipPermissions()).toBe(true);
  });
});
