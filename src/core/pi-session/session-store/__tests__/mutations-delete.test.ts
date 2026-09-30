import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionManager } from '@earendil-works/pi-coding-agent';

const { tmpHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { tmpHome: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-delete-home-')) };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

import { deletePiSession } from '../mutations';
import { ensurePiSessionDir } from '../session-dir';
import { getPiCodingAgent, initPiLoader } from '../../pi-loader';
import { DAMOCLES_PLANS_DIR, planFileIdSuffix } from '../../../paths';

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const cwd = path.join(tmpHome, 'workspace');
const legacyRoot = path.join(
  tmpHome,
  '.damocles',
  'pi',
  'subagents',
  cwd.replace(/^[A-Za-z]:[/\\]/, '').replace(/[/\\:]/g, '-').replace(/^-+/, ''),
);

type Message = Parameters<SessionManager['appendMessage']>[0];
const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }) as Message;
const assistant = (text: string): Message =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  }) as unknown as Message;

function write(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
}

/** A persisted parent session plus agent data in its subtree and in the legacy transcript folder. */
async function sessionWithAgentData(): Promise<{ id: string; file: string; files: string[] }> {
  await initPiLoader();
  const pi = getPiCodingAgent();
  if (!pi) throw new Error('pi coding-agent failed to load');
  const dir = ensurePiSessionDir(cwd);
  const sm = pi.SessionManager.create(cwd, dir);
  sm.appendMessage(user('hi'));
  sm.appendMessage(assistant('hello'));
  const id = sm.getSessionId();
  const files = [
    path.join(dir, id, 'subagents', 'x_agent.jsonl'),
    path.join(dir, id, 'teams', 'team.jsonl'),
    path.join(dir, id, 'teams', 'team', 'checkpoints', '1700000000000.json'),
    path.join(dir, id, 'teams', 'team', 'members', 'x_member.a0.jsonl'),
    path.join(legacyRoot, id, 'tasks', 'agent.jsonl'),
  ];
  files.forEach(write);
  return { id, file: sm.getSessionFile()!, files };
}

describe('deletePiSession — agent data', () => {
  it('removes the session’s agent folders and legacy transcripts, and leaves a sibling session’s alone', async () => {
    const doomed = await sessionWithAgentData();
    const sibling = await sessionWithAgentData();

    await deletePiSession(cwd, doomed.id);

    const dir = ensurePiSessionDir(cwd);
    expect(fs.existsSync(doomed.file)).toBe(false);
    expect(fs.existsSync(path.join(dir, doomed.id))).toBe(false);
    expect(fs.existsSync(path.join(legacyRoot, doomed.id))).toBe(false);
    expect(fs.existsSync(sibling.file)).toBe(true);
    for (const file of sibling.files) expect(fs.existsSync(file)).toBe(true);
  });

  it('removes the agent data and plan files of a session whose file is already gone', async () => {
    const doomed = await sessionWithAgentData();
    const sibling = await sessionWithAgentData();
    const plan = path.join(DAMOCLES_PLANS_DIR, `orphan-${planFileIdSuffix(doomed.id)}.md`);
    write(plan);
    fs.rmSync(doomed.file);

    await deletePiSession(cwd, doomed.id);

    expect(fs.existsSync(path.join(ensurePiSessionDir(cwd), doomed.id))).toBe(false);
    expect(fs.existsSync(path.join(legacyRoot, doomed.id))).toBe(false);
    expect(fs.existsSync(plan)).toBe(false);
    for (const file of sibling.files) expect(fs.existsSync(file)).toBe(true);
  });

  it('never deletes outside the session’s own folders when the id is not a safe path segment', async () => {
    const sibling = await sessionWithAgentData();
    const dir = ensurePiSessionDir(cwd);
    // A session file whose id, as read from its name, is "..".
    const unsafe = path.join(dir, '2026-01-01T00-00-00-000Z_...jsonl');
    fs.writeFileSync(unsafe, '');

    await deletePiSession(cwd, '..');

    expect(fs.existsSync(unsafe)).toBe(false);
    expect(fs.existsSync(sibling.file)).toBe(true);
    for (const file of sibling.files) expect(fs.existsSync(file)).toBe(true);
  });
});
