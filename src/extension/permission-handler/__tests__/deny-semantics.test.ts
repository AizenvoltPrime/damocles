import { describe, it, expect, vi, afterAll } from 'vitest';
import { buildUserDenyResult, buildUserFileEditDenyResult, buildUnaskedDenyResult } from '../utils';
import { ApprovalManager } from '../managers/approval-manager';
import { SkillManager } from '../managers/skill-manager';
import { PermissionState } from '../state';
import type { CanUseToolContext, PostMessageFn } from '../types';
import type { DiffManager } from '../diff-manager';
import { FEEDBACK_MARKER } from '../../../shared/types/constants';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PermissionHandler } from '../index';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

vi.mock('../../skills/utils', () => ({ loadSkillDescription: async () => undefined }));

// User-scope settings resolve through `os.homedir()`; a temp dir keeps the developer's own rules out.
const H = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-deny-'));
  return { root, home: nodePath.join(root, 'home') };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => H.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

function makeDiffManager(): DiffManager {
  return {
    prepareDiff: async () => ({ originalContent: 'a', proposedContent: 'b' }),
    showDiffView: async () => undefined,
    closeDiffView: async () => undefined,
  } as unknown as DiffManager;
}

function ctx(toolUseID: string | null, signal = new AbortController().signal): CanUseToolContext {
  return { signal, toolUseID, parentToolUseId: null };
}

const EDIT_INPUT = { file_path: '/a.ts', old_string: 'a', new_string: 'b' };

/**
 * `interrupt` becomes pi's `terminate` and ends the user's turn. It must be reachable ONLY from a real
 * user rejection with an empty feedback box — never inferred from an absent string on a path where
 * nobody was ever asked. These tests assert PRESENCE, because `exactOptionalPropertyTypes` makes
 * "absent" the contract; `{ interrupt: undefined }` would be a regression.
 */
describe('deny builders — only an answered prompt may end the turn', () => {
  it('a user deny with no feedback interrupts', () => {
    expect(buildUserDenyResult(undefined, 'User rejected the shell command')).toEqual({
      behavior: 'deny',
      message: 'User rejected the shell command',
      interrupt: true,
    });
    expect(buildUserFileEditDenyResult(undefined, 'User rejected the file modification').interrupt).toBe(true);
  });

  it('a user deny with feedback does not interrupt and carries the feedback marker', () => {
    const r = buildUserDenyResult('do X instead', 'unused');
    expect(r).not.toHaveProperty('interrupt');
    expect(r.message).toContain(FEEDBACK_MARKER);
    expect(r.message).toContain('do X instead');

    const edit = buildUserFileEditDenyResult('do X instead', 'unused');
    expect(edit).not.toHaveProperty('interrupt');
    expect(edit.message).toContain('the new_string was NOT written to the file');
  });

  it('an unasked deny never interrupts, with or without a diagnostic', () => {
    expect(buildUnaskedDenyResult(undefined, 'Permission denied by settings rule')).toEqual({
      behavior: 'deny',
      message: 'Permission denied by settings rule',
    });
    expect(buildUnaskedDenyResult('webview not available', 'unused')).not.toHaveProperty('interrupt');
  });
});

describe('ApprovalManager — infra failures must not end the turn', () => {
  it('no webview: file + shell deny without interrupt', async () => {
    const state = new PermissionState();
    const manager = new ApprovalManager(state, makeDiffManager(), () => null);

    const file = await manager.handleFilePermission('Edit', EDIT_INPUT, ctx('t1'));
    expect(file.behavior).toBe('deny');
    expect(file).not.toHaveProperty('interrupt');
    expect(file.message).toContain('webview not available');

    const shell = await manager.handleShellPermission('Bash', { command: 'ls' }, ctx('t1'));
    expect(shell.behavior).toBe('deny');
    expect(shell).not.toHaveProperty('interrupt');
  });

  it('no tool use id: file + shell deny without interrupt', async () => {
    const state = new PermissionState();
    const post = vi.fn() as unknown as PostMessageFn;
    const manager = new ApprovalManager(state, makeDiffManager(), () => post);

    const file = await manager.handleFilePermission('Edit', EDIT_INPUT, ctx(null));
    expect(file).not.toHaveProperty('interrupt');
    expect(file.message).toContain('no tool use ID');

    const shell = await manager.handleShellPermission('Bash', { command: 'ls' }, ctx(null));
    expect(shell).not.toHaveProperty('interrupt');
  });

  it('an abort during session teardown denies without interrupt', async () => {
    const state = new PermissionState();
    state.sessionAborting = true;
    const manager = new ApprovalManager(state, makeDiffManager(), () => (vi.fn() as unknown as PostMessageFn));
    const controller = new AbortController();

    const pending = manager.handleShellPermission('Bash', { command: 'ls' }, ctx('t1', controller.signal));
    controller.abort();
    const result = await pending;

    expect(result.behavior).toBe('deny');
    expect(result).not.toHaveProperty('interrupt');
  });

  it('a REAL user Deny with an empty feedback box still interrupts', async () => {
    const state = new PermissionState();
    const manager = new ApprovalManager(state, makeDiffManager(), () => (vi.fn() as unknown as PostMessageFn));

    const pending = manager.handleShellPermission('Bash', { command: 'ls' }, ctx('t1'));
    await manager.resolveApproval('t1', false);
    const result = await pending;

    expect(result.behavior).toBe('deny');
    expect(result.interrupt).toBe(true);
  });

  it('a REAL user Deny with feedback does not interrupt', async () => {
    const state = new PermissionState();
    const manager = new ApprovalManager(state, makeDiffManager(), () => (vi.fn() as unknown as PostMessageFn));

    const pending = manager.handleShellPermission('Bash', { command: 'ls' }, ctx('t1'));
    await manager.resolveApproval('t1', false, { customMessage: 'run it with --dry-run' });
    const result = await pending;

    expect(result).not.toHaveProperty('interrupt');
    expect(result.message).toContain('run it with --dry-run');
  });

  it('PermissionState.clearAll resolves pending approvals as unasked, not as a user "no"', async () => {
    const state = new PermissionState();
    const manager = new ApprovalManager(state, makeDiffManager(), () => (vi.fn() as unknown as PostMessageFn));

    const pending = manager.handleShellPermission('Bash', { command: 'ls' }, ctx('t1'));
    state.clearAll();
    const result = await pending;

    expect(result.behavior).toBe('deny');
    expect(result).not.toHaveProperty('interrupt');
    expect(result.message).toContain('The session ended');
  });
});

describe('SkillManager — infra failures must not end the turn', () => {
  it('no tool use id / no webview deny without interrupt', async () => {
    const state = new PermissionState();
    const noId = new SkillManager(state, () => (vi.fn() as unknown as PostMessageFn));
    const idResult = await noId.handleSkillApproval({ skill: 'demo' }, ctx(null));
    expect(idResult.behavior).toBe('deny');
    expect(idResult).not.toHaveProperty('interrupt');
    expect(idResult.message).toContain('no tool use ID');

    const noWebview = new SkillManager(state, () => null);
    const webviewResult = await noWebview.handleSkillApproval({ skill: 'demo' }, ctx('t1'));
    expect(webviewResult).not.toHaveProperty('interrupt');
    expect(webviewResult.message).toContain('webview not available');
  });

  it('an abort while waiting denies without interrupt', async () => {
    const state = new PermissionState();
    const manager = new SkillManager(state, () => (vi.fn() as unknown as PostMessageFn));
    const controller = new AbortController();

    const pending = manager.handleSkillApproval({ skill: 'demo' }, ctx('t1', controller.signal));
    await vi.waitFor(() => expect(state.pendingSkillApprovals.has('t1')).toBe(true));
    controller.abort();
    const result = await pending;

    expect(result.behavior).toBe('deny');
    expect(result).not.toHaveProperty('interrupt');
  });

  it('a REAL user Deny of a skill with no feedback still interrupts', async () => {
    const state = new PermissionState();
    const manager = new SkillManager(state, () => (vi.fn() as unknown as PostMessageFn));

    const pending = manager.handleSkillApproval({ skill: 'demo' }, ctx('t1'));
    await vi.waitFor(() => expect(state.pendingSkillApprovals.has('t1')).toBe(true));
    manager.resolveSkillApproval('t1', false);
    const result = await pending;

    expect(result.interrupt).toBe(true);
  });
});

/**
 * The full `canUseTool` path for a shell call, in two panels of one multi-root window. A rule in
 * folder B's own settings runs the command unasked in B, and must never reach a panel on folder A.
 */
describe("PermissionHandler.canUseTool applies only the panel folder's rules", () => {
  const folderA = path.join(H.root, 'a');
  const folderB = path.join(H.root, 'b');
  const npmTest = { command: 'npm test' };

  afterAll(() => {
    fs.rmSync(H.root, { recursive: true, force: true });
  });

  function makeHandler(workspacePath: string): { handler: PermissionHandler; posted: ExtensionToWebviewMessage[] } {
    (vscode.workspace as unknown as Record<string, unknown>)['registerTextDocumentContentProvider'] = () => ({ dispose: () => undefined });
    const handler = new PermissionHandler(vscode.Uri.file(H.root) as unknown as vscode.Uri);
    const posted: ExtensionToWebviewMessage[] = [];
    handler.setPostMessage((m) => posted.push(m));
    handler.setWorkspacePath(workspacePath);
    return { handler, posted };
  }

  it('auto-allows in B and asks in A', async () => {
    fs.mkdirSync(path.join(folderA, '.damocles'), { recursive: true });
    fs.mkdirSync(path.join(folderB, '.damocles'), { recursive: true });
    fs.writeFileSync(path.join(folderB, '.damocles', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));

    const b = makeHandler(folderB);
    const inB = await b.handler.canUseTool('Bash', npmTest, ctx('tb'));
    expect(inB.behavior).toBe('allow');
    expect(b.posted.filter((m) => m.type === 'requestPermission')).toHaveLength(0);

    const a = makeHandler(folderA);
    const pending = a.handler.canUseTool('Bash', npmTest, ctx('ta'));
    await vi.waitFor(() => expect(a.posted.filter((m) => m.type === 'requestPermission')).toHaveLength(1));
    await a.handler.resolveApproval('ta', false, { customMessage: 'not here' });
    expect((await pending).behavior).toBe('deny');
  });
});
