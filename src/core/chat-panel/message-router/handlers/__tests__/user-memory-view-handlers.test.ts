import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbHolder = vi.hoisted(() => ({ path: '' }));

vi.mock('../../../../memory/database', async (importActual) => {
  const actual = await importActual<typeof import('../../../../memory/database')>();
  return {
    ...actual,
    openDatabaseAsync: vi.fn(async () => {
      const raw = new DatabaseSync(dbHolder.path, { timeout: 5000, enableForeignKeyConstraints: true });
      raw.exec('PRAGMA journal_mode = WAL');
      const db = actual.createDatabaseWrapper(raw);
      actual.runMigrations(db);
      return { db };
    }),
  };
});

vi.mock('../../../../memory/subcall-runner', () => ({
  createMemorySubCallRunner: () => ({ run: vi.fn(async () => ({ value: null, failure: 'no-model' as const })) }),
  describeMemorySubCallModel: () => null,
}));

import { createUserMemoryViewHandlers } from '../user-memory-view-handlers';
import { MemoryService } from '../../../../memory';
import { globalMemoryId } from '../../../../memory/global-memory-relay';
import { createTestDbPath } from '../../../../memory/__tests__/test-helpers';
import { installPlatform } from '../../../../platform-host';
import { createFakePlatform } from '../../../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../../../__mocks__/fake-remote-host';
import { MAX_GLOBAL_MEMORY_LABEL_CHARS, MAX_GLOBAL_MEMORY_TAGS, MAX_VIEW_REQUEST_ID_CHARS, USER_MEMORY_VIEW_SOURCES } from '../../../../../shared/remote-user';
import { MAX_MEMORY_CONTENT_CHARS } from '../../../../../shared/types/memory';
import type { HandlerDependencies, ViewHandlerRegistry } from '../../types';
import type { Platform } from '../../../../../platform/platform';
import type { PanelHost } from '../../../../../platform/window-service';
import type { Disposable } from '../../../../../platform/disposable';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../../../shared/types/messages';

// This computer's core answering a remote chat page's reads and changes of its notes and global memories.
let closeHost: () => void = () => undefined;
const host = { onDispose: (listener: () => void) => { closeHost = listener; return { dispose: () => undefined }; } } as unknown as PanelHost;
let platform: Platform;
let service: MemoryService;
let handlers: ViewHandlerRegistry;
let posted: ExtensionToWebviewMessage[];
let outboxDir: string;
let subscriptions: Disposable[];

const send = async (message: Record<string, unknown>): Promise<ExtensionToWebviewMessage[]> => {
  posted.length = 0;
  await handlers[message.type as string]!(message as unknown as WebviewToExtensionMessage, { host });
  return [...posted];
};

const NOT_GLOBAL = (request: string) => ({ type: 'userMemoryError', request, message: { message: 'This memory is not one of your global memories.' } });
const MALFORMED = { message: 'The memory panel sent a change this computer does not accept.' };

function seed(id: string, scope: 'global' | 'project', kind = 'fact', content = `content ${id}`): void {
  const now = Date.now();
  service.database!.prepare(
    `INSERT INTO memories (id, kind, scope, content, content_hash, workspace, root_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, kind, scope, content, `hash-${id}`, scope === 'project' ? '/repo' : null, id, now, now);
}

const row = (id: string): Record<string, unknown> | undefined =>
  service.database!.prepare('SELECT content, forgotten, pinned FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined;

async function start(remote = false): Promise<void> {
  dbHolder.path = createTestDbPath();
  const base = createFakePlatform();
  platform = remote ? { ...base, remote: createFakeRemoteHost().remote } : base;
  installPlatform(platform);
  outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  service = new MemoryService({ ...platform, outboxDir });
  await service.ensureInitialized();
  posted = [];
  subscriptions = [];
  handlers = createUserMemoryViewHandlers({ postMessage: (_host: PanelHost, message: ExtensionToWebviewMessage) => posted.push(message), memoryService: service, platform, subscriptions } as unknown as HandlerDependencies);
}

afterEach(async () => {
  for (const subscription of subscriptions) subscription.dispose();
  await service.dispose();
  installPlatform(createFakePlatform());
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

describe("this computer's core and a remote chat page's memories", () => {
  beforeEach(() => start());

  it('has a handler for each user-memory request type', () => {
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(USER_MEMORY_VIEW_SOURCES).sort());
  });

  it('lists only global rows, and answers available false with memory off on this computer', async () => {
    seed('g1', 'global');
    seed('n1', 'global', 'note');
    seed('p1', 'project');
    const [update] = await send({ type: 'requestUserMemories' });
    expect(update).toMatchObject({ type: 'userMemoriesUpdate', available: true });
    expect((update as { memories: Array<{ id: string }> }).memories.map((memory) => memory.id).sort()).toEqual(['g1', 'n1']);
    await platform.settings.update('damocles.memory.enabled', false, 'user');
    posted.length = 0;
    expect(await send({ type: 'requestUserMemories' })).toEqual([{ type: 'userMemoriesUpdate', memories: [], available: false }]);
    expect(await send({ type: 'pinUserMemory', id: 'g1' })).toEqual([{ type: 'userMemoryError', request: 'pinUserMemory', message: { message: 'Memory system is not available' } }]);
  });

  it('answers the profile read quietly with memory off on this computer', async () => {
    await service.setProfileSection('global', '', 'static', 'likes tea');
    await platform.settings.update('damocles.memory.enabled', false, 'user');
    expect(await send({ type: 'getUserProfile' })).toEqual([{ type: 'userProfileData', global: { static: '', dynamic: '' }, available: false }]);
  });

  it('answers each page that asked again when memory turns off or on here, and none once its view closed', async () => {
    seed('g1', 'global');
    await send({ type: 'requestUserMemories' });
    posted.length = 0;
    await platform.settings.update('damocles.memory.enabled', false, 'user');
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted).toEqual(expect.arrayContaining([
      { type: 'userMemoriesUpdate', memories: [], available: false },
      { type: 'userProfileData', global: { static: '', dynamic: '' }, available: false },
    ]));
    posted.length = 0;
    await platform.settings.update('damocles.memory.enabled', true, 'user');
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'userMemoriesUpdate', available: true, memories: [expect.objectContaining({ id: 'g1' })] }),
      { type: 'userProfileData', global: { static: '', dynamic: '' }, available: true },
    ]));
    closeHost();
    posted.length = 0;
    await platform.settings.update('damocles.memory.enabled', false, 'user');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted).toEqual([]);
  });

  it('pins, unpins, forgets, unforgets and deletes a global row and a note, answering with its own types', async () => {
    seed('g1', 'global');
    seed('n1', 'global', 'note');
    expect(await send({ type: 'pinUserMemory', id: 'g1' })).toEqual([{ type: 'userMemoryPinned', id: 'g1' }]);
    expect(row('g1')).toMatchObject({ pinned: 1 });
    expect(await send({ type: 'unpinUserMemory', id: 'g1' })).toEqual([{ type: 'userMemoryUnpinned', id: 'g1' }]);
    expect(await send({ type: 'forgetUserMemory', id: 'n1', scope: 'version' })).toEqual([{ type: 'userMemoryForgotten', id: 'n1', count: 1 }]);
    expect(row('n1')).toMatchObject({ forgotten: 1 });
    expect(await send({ type: 'unforgetUserMemory', id: 'n1' })).toEqual([{ type: 'userMemoryUnforgotten', id: 'n1', count: 1 }]);
    expect(await send({ type: 'deleteUserMemory', id: 'n1' })).toEqual([{ type: 'userMemoryDeleted', id: 'n1' }]);
    expect(row('n1')).toBeUndefined();
  });

  it('refuses a project row, a relayed id, an unknown id and a malformed id before any change', async () => {
    seed('p1', 'project');
    seed('g1', 'global');
    for (const id of ['p1', globalMemoryId('client-a', 'g1'), 'missing', 7, 'x'.repeat(200), undefined]) {
      for (const type of ['deleteUserMemory', 'pinUserMemory', 'unpinUserMemory', 'forgetUserMemory', 'unforgetUserMemory']) {
        expect(await send({ type, id }), `${type} ${String(id)}`).toEqual([NOT_GLOBAL(type)]);
      }
      for (const type of ['getUserMemoryHistory', 'getUserRelatedMemories']) {
        expect(await send({ type, id })).toEqual([NOT_GLOBAL(type)]);
      }
    }
    expect(row('p1')).toMatchObject({ forgotten: 0, pinned: 0 });
    expect(row('g1')).toMatchObject({ forgotten: 0, pinned: 0 });
  });

  it('refuses a global row of this store whose id has the relayed form, which a remote core\'s write uuid can give it', async () => {
    const relayed = globalMemoryId('client-a', 'g1');
    seed(relayed, 'global');
    for (const type of ['pinUserMemory', 'forgetUserMemory', 'deleteUserMemory']) expect(await send({ type, id: relayed }), type).toEqual([NOT_GLOBAL(type)]);
    expect(row(relayed)).toMatchObject({ forgotten: 0, pinned: 0 });
  });

  it('refuses a forget or unforget scope other than version or chain', async () => {
    seed('g1', 'global');
    expect(await send({ type: 'forgetUserMemory', id: 'g1', scope: 'all' })).toEqual([{ type: 'userMemoryError', request: 'forgetUserMemory', message: MALFORMED }]);
    expect(await send({ type: 'unforgetUserMemory', id: 'g1', scope: 3 })).toEqual([{ type: 'userMemoryError', request: 'unforgetUserMemory', message: MALFORMED }]);
    expect(row('g1')).toMatchObject({ forgotten: 0 });
  });

  it("answers a global row's history and neighbours with global rows only", async () => {
    seed('g1', 'global');
    seed('p1', 'project');
    const now = Date.now();
    service.database!.prepare("INSERT INTO memory_edges (id, kind, source_id, target_id, created_at) VALUES ('e1', 'EXTENDS', 'g1', 'p1', ?)").run(now);
    expect(await send({ type: 'getUserMemoryHistory', id: 'g1' })).toEqual([{ type: 'userMemoryHistory', id: 'g1', entries: [expect.objectContaining({ id: 'g1' })] }]);
    expect(await send({ type: 'getUserRelatedMemories', id: 'g1' })).toEqual([{ type: 'userRelatedMemories', id: 'g1', entries: [] }]);
  });

  it('creates a global memory or a note with the requestId echoed', async () => {
    const [fact] = await send({ type: 'createUserMemory', tier: 'global', kind: 'preference', content: 'prefers tabs', tags: ['style'], requestId: 'r1' });
    expect(fact).toMatchObject({ type: 'userMemoryCreated', requestId: 'r1', memory: { scope: 'global', kind: 'preference', content: 'prefers tabs', tags: ['style'] } });
    const [note] = await send({ type: 'createUserMemory', tier: 'note', content: 'a note' });
    expect(note).toMatchObject({ type: 'userMemoryCreated', memory: { scope: 'global', kind: 'note', content: 'a note' } });
    expect(note).not.toHaveProperty('requestId');
  });

  it('refuses a create past its bounds before any write, echoing only a valid requestId', async () => {
    const count = (): number => (service.database!.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    const failure = (message: unknown, requestId?: string) => [{ type: 'userMemoryError', request: 'createUserMemory', message, ...(requestId ? { requestId } : {}) }];
    expect(await send({ type: 'createUserMemory', tier: 'project', content: 'c', requestId: 'r1' })).toEqual(failure(MALFORMED, 'r1'));
    expect(await send({ type: 'createUserMemory', tier: 'session', content: 'c' })).toEqual(failure(MALFORMED));
    expect(await send({ type: 'createUserMemory', tier: 'global', kind: 'observation', content: 'c' })).toEqual(failure(MALFORMED));
    expect(await send({ type: 'createUserMemory', tier: 'note', kind: 'fact', content: 'c' })).toEqual(failure(MALFORMED));
    expect(await send({ type: 'createUserMemory', tier: 'note', content: '' })).toEqual(failure(MALFORMED));
    expect(await send({ type: 'createUserMemory', tier: 'note', content: 5 })).toEqual(failure(MALFORMED));
    expect(await send({ type: 'createUserMemory', tier: 'note', content: 'x'.repeat(MAX_MEMORY_CONTENT_CHARS + 1), requestId: 'r2' }))
      .toEqual(failure({ message: 'A memory holds at most {0} characters.', args: [MAX_MEMORY_CONTENT_CHARS] }, 'r2'));
    expect(await send({ type: 'createUserMemory', tier: 'note', content: 'c', tags: Array.from({ length: MAX_GLOBAL_MEMORY_TAGS + 1 }, (_, index) => `t${index}`) })).toEqual(failure(MALFORMED));
    expect(await send({ type: 'createUserMemory', tier: 'note', content: 'c', tags: ['x'.repeat(MAX_GLOBAL_MEMORY_LABEL_CHARS + 1)] })).toEqual(failure(MALFORMED));
    expect(await send({ type: 'createUserMemory', tier: 'note', content: 'c', tags: 'work' })).toEqual(failure(MALFORMED));
    expect(await send({ type: 'createUserMemory', tier: 'note', content: 'c', requestId: 'r'.repeat(MAX_VIEW_REQUEST_ID_CHARS + 1) })).toEqual(failure(MALFORMED));
    expect(count()).toBe(0);
  });

  it('saves a global profile section and answers with the global profile alone', async () => {
    expect(await send({ type: 'setUserProfileSection', section: 'static', content: 'likes tea' })).toEqual([
      { type: 'userProfileData', global: { static: 'likes tea', dynamic: '' }, available: true, savedSection: { scope: 'global', section: 'static' } },
    ]);
    expect(await send({ type: 'getUserProfile' })).toEqual([{ type: 'userProfileData', global: { static: 'likes tea', dynamic: '' }, available: true }]);
    expect(service.getProfile('project', '/repo')).toEqual({ static: '', dynamic: '' });
  });

  it('refuses a profile section other than static or dynamic, and content past the bound', async () => {
    expect(await send({ type: 'setUserProfileSection', section: 'project', content: 'x' })).toEqual([{ type: 'userMemoryError', request: 'setUserProfileSection', message: MALFORMED }]);
    expect(await send({ type: 'setUserProfileSection', section: 'dynamic', content: 4 })).toEqual([{ type: 'userProfileSectionError', section: 'dynamic', message: MALFORMED }]);
    expect(await send({ type: 'setUserProfileSection', section: 'dynamic', content: 'x'.repeat(MAX_MEMORY_CONTENT_CHARS + 1) })).toEqual([
      { type: 'userProfileSectionError', section: 'dynamic', message: { message: 'A memory holds at most {0} characters.', args: [MAX_MEMORY_CONTENT_CHARS] } },
    ]);
    expect(service.getProfile('global', '')).toEqual({ static: '', dynamic: '' });
  });
});

describe("a daemon's core and a remote chat page's memories", () => {
  beforeEach(() => start(true));

  it('refuses every request, since its global memory is its clients\'', async () => {
    const refusal = { message: 'Your notes and global memories are on your computer, not on this host.' };
    const messages: Array<Record<string, unknown>> = [
      { type: 'requestUserMemories' },
      { type: 'getUserMemoryHistory', id: 'm1' },
      { type: 'getUserRelatedMemories', id: 'm1' },
      { type: 'getUserProfile' },
      { type: 'createUserMemory', tier: 'note', content: 'c', requestId: 'r1' },
      { type: 'deleteUserMemory', id: 'm1' },
      { type: 'pinUserMemory', id: 'm1' },
      { type: 'unpinUserMemory', id: 'm1' },
      { type: 'forgetUserMemory', id: 'm1' },
      { type: 'unforgetUserMemory', id: 'm1' },
      { type: 'setUserProfileSection', section: 'static', content: 'c' },
    ];
    const answers = [];
    for (const message of messages) answers.push(...(await send(message)));
    expect(answers).toEqual([
      ...messages.slice(0, 4).map(({ type }) => ({ type: 'userMemoryError', request: type, message: refusal })),
      { type: 'userMemoryError', request: 'createUserMemory', message: refusal, requestId: 'r1' },
      ...messages.slice(5, 10).map(({ type }) => ({ type: 'userMemoryError', request: type, message: refusal })),
      { type: 'userProfileSectionError', section: 'static', message: refusal },
    ]);
    expect(vi.mocked((platform.remote!).memoryApply)).not.toHaveBeenCalled();
  });
});
