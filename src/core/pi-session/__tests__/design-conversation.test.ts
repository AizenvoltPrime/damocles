import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as pi from '@earendil-works/pi-coding-agent';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { PermissionHandler } from '../../permission-handler';
import type { SessionOptions } from '../../session-types';
import type { DesignSeed } from '../../design/tools/start-design';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { designRoleEntryData } from '../../design/design-entries';
import { designFolderOf } from '../../design/design-paths';
import { PiSession } from '../pi-session';
import { ensurePiSessionDir } from '../session-store';

vi.mock('../../logger', () => ({ log: vi.fn() }));

type Message = Parameters<SessionManager['appendMessage']>[0];
const CWD = path.resolve('/design-conversation-cwd');
const DESIGN = 'contacts-abcd1234';
const seed: DesignSeed = { designId: DESIGN, title: 'Contacts', parentSessionId: 'parent-1', ruleSet: 'full' };

const panels: PiSession[] = [];
function panel(design?: DesignSeed): PiSession {
  const options = {
    cwd: CWD,
    projectScope: true,
    platform: createFakePlatform(),
    permissionHandler: { getPermissionMode: () => 'default', setPendingPromptsListener: () => {}, setPromptOwnerResolver: () => {}, pendingPrompts: () => [], repostPendingPrompts: () => {} } as unknown as PermissionHandler,
    onMessage: () => undefined,
    resolveThinking: () => ({ thinkingDisabled: true, effort: null }),
    ...(design ? { design } : {}),
  } as unknown as SessionOptions;
  const created = new PiSession(options);
  panels.push(created);
  return created;
}

/** A stored conversation of CWD with a first exchange, a design chat's when `designChat`; returns its id and file. */
function storedConversation(designChat: boolean): { id: string; file: string } {
  const dir = ensurePiSessionDir(CWD);
  const sm = pi.SessionManager.create(CWD, dir);
  if (designChat) sm.appendCustomEntry('damocles.design', designRoleEntryData({ designId: DESIGN, folder: designFolderOf(DESIGN), parentSessionId: 'parent-1', ruleSet: 'full', title: 'Contacts' }));
  sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'design the contacts list' }], timestamp: Date.now() } as Message);
  sm.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as unknown as Message);
  return { id: sm.getSessionId(), file: sm.getSessionFile()! };
}

afterEach(async () => {
  await Promise.all(panels.splice(0).map((p) => p.dispose()));
});

describe('PiSession.isDesignConversation (D70) before the session starts', () => {
  it('is true for a panel holding a design seed no conversation recorded yet', async () => {
    expect(await panel(seed).isDesignConversation()).toBe(true);
  });

  it('is true for a panel restored onto a stored design chat, and reads the file without writing it', async () => {
    const stored = storedConversation(true);
    const before = fs.readFileSync(stored.file, 'utf8');
    const restored = panel();
    restored.setResumeSession(stored.id);
    expect(await restored.isDesignConversation()).toBe(true);
    expect(fs.readFileSync(stored.file, 'utf8')).toBe(before);
  });

  it('is false for a panel restored onto a plain stored conversation, and for a plain panel with no target', async () => {
    const restored = panel();
    restored.setResumeSession(storedConversation(false).id);
    expect(await restored.isDesignConversation()).toBe(false);
    expect(await panel().isDesignConversation()).toBe(false);
  });
});
