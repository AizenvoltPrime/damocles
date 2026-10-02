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
  return { tmpHome: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-prompt-only-home-')) };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

import { deletePiSession, listPiSessions, renamePiSession, tagPiSession } from '..';
import { ensurePiSessionDir } from '../session-dir';
import { getPiCodingAgent, initPiLoader } from '../../pi-loader';
import { whileSessionLeased } from '../../../chat-panel/session-ownership';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const cwd = path.join(tmpHome, 'workspace');

type Message = Parameters<SessionManager['appendMessage']>[0];

/** The file a first turn leaves when it fails before any reply: pi commits the prompt and nothing after it. */
async function promptOnlySession(): Promise<{ id: string; file: string }> {
  await initPiLoader();
  const pi = getPiCodingAgent();
  if (!pi) throw new Error('pi coding-agent failed to load');
  const sm = pi.SessionManager.create(cwd, ensurePiSessionDir(cwd));
  sm.appendModelChange('anthropic', 'claude-opus-5-5');
  expect(fs.existsSync(sm.getSessionFile()!)).toBe(false);
  sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'fix the parser' }], timestamp: Date.now() } as Message);
  return { id: sm.getSessionId(), file: sm.getSessionFile()! };
}

describe('a conversation whose first turn failed before any reply', () => {
  it('has a file holding its prompt, which the session list shows and leased rename, tag and delete act on', async () => {
    const { notifications } = createFakePlatform();
    const { id, file } = await promptOnlySession();
    expect(fs.existsSync(file)).toBe(true);

    const listed = (await listPiSessions(cwd)).find((s) => s.id === id);
    expect(listed).toMatchObject({ id, preview: 'fix the parser' });

    expect(await whileSessionLeased(notifications, id, () => renamePiSession(cwd, id, 'Parser fix'))).toBe(true);
    expect(await whileSessionLeased(notifications, id, () => tagPiSession(cwd, id, 'bug'))).toBe(true);
    expect((await listPiSessions(cwd)).find((s) => s.id === id)).toMatchObject({ customTitle: 'Parser fix', tag: 'bug' });

    let refsDeleted: Promise<void> | undefined;
    expect(await whileSessionLeased(notifications, id, async () => {
      ({ refsDeleted } = await deletePiSession(cwd, id));
    })).toBe(true);
    await refsDeleted;
    expect(fs.existsSync(file)).toBe(false);
    expect((await listPiSessions(cwd)).some((s) => s.id === id)).toBe(false);
  });
});
