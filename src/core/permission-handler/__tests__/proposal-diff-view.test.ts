import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PermissionHandler } from '../index';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { CanUseToolContext } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { DiffManager } from '../diff-manager';
import { FILE_PATCH_MAX_BYTES } from '../../pi-session/tools/file-patch';
import { platform as hostPlatform } from '../../platform-host';

function handlerFor(panelId: string): { handler: PermissionHandler; platform: FakePlatform } {
  const platform = createFakePlatform();
  vi.spyOn(platform.editor, 'readText').mockResolvedValue('alpha\nbeta\n');
  const handler = new PermissionHandler(platform, panelId);
  handler.setCwd(process.cwd());
  handler.setPostMessage(() => undefined);
  return { handler, platform };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never held');
}

function requestEdit(handler: PermissionHandler, toolUseID: string, signal = new AbortController().signal): Promise<unknown> {
  const ctx: CanUseToolContext = { signal, toolUseID, parentToolUseId: null };
  return handler.canUseTool('Edit', { file_path: '/tmp/a.txt', old_string: 'alpha', new_string: 'omega' }, ctx);
}

describe('proposal diff view', () => {
  it('names the owning panel and the permission prompt it belongs to', async () => {
    const { handler, platform } = handlerFor('host-7');
    void requestEdit(handler, 't1');
    await waitFor(() => handler.pendingPromptKinds().size > 0);

    expect(platform.editor.diffs[0]?.request).toMatchObject({ purpose: 'proposal', panelId: 'host-7', approvalId: 't1' });
  });

  it('opens without taking focus from the chat', async () => {
    const { handler, platform } = handlerFor('host-1');
    void requestEdit(handler, 't1');
    await waitFor(() => handler.pendingPromptKinds().size > 0);

    expect(platform.editor.diffs[0]?.request.preserveFocus).toBe(true);
  });

  it.each([
    ['approve', true],
    ['reject', false],
  ])('closes when the user decides (%s)', async (_label, approved) => {
    const { handler, platform } = handlerFor('host-1');
    const decision = requestEdit(handler, 't1');
    await waitFor(() => handler.pendingPromptKinds().size > 0);

    await handler.resolveApproval('t1', approved);

    await expect(decision).resolves.toMatchObject({ behavior: approved ? 'allow' : 'deny' });
    expect(platform.editor.diffs[0]?.closeCalls).toBe(1);
  });

  it('closes when the tool call is aborted', async () => {
    const { handler, platform } = handlerFor('host-1');
    const controller = new AbortController();
    const decision = requestEdit(handler, 't1', controller.signal);
    await waitFor(() => handler.pendingPromptKinds().size > 0);

    controller.abort();
    await decision;

    expect(platform.editor.diffs[0]?.closeCalls).toBe(1);
  });

  it('closes when the panel is disposed', async () => {
    const { handler, platform } = handlerFor('host-1');
    void requestEdit(handler, 't1');
    await waitFor(() => handler.pendingPromptKinds().size > 0);

    await handler.dispose();

    expect(platform.editor.diffs[0]?.closeCalls).toBe(1);
  });
});

describe('proposal diff content and title', () => {
  it('shows replacement patterns in new_string literally, as Edit writes them', async () => {
    const platform = createFakePlatform();
    vi.spyOn(platform.editor, 'readText').mockResolvedValue('const escaped = s;\r\nconst pid = 0;\r\n');
    const diff = await new DiffManager(platform.editor, 'host-1').prepareDiff('t1', 'Edit', '/tmp/a.ts', {
      old_string: 'const escaped = s;\nconst pid = 0;',
      new_string: "const escaped = s.replace(/[.*]/g, '\\$&');\nconst pid = $$ + $` + $';",
    });
    expect(diff?.proposedContent).toBe("const escaped = s.replace(/[.*]/g, '\\$&');\r\nconst pid = $$ + $` + $';\r\n");
  });

  it('localizes the diff title', async () => {
    const platform = createFakePlatform();
    vi.spyOn(hostPlatform().localization, 't').mockImplementation((message: string, ...args) => `[el] ${message.replace('{0}', String(args[0]))}`);
    await new DiffManager(platform.editor, 'host-1').showDiffView('t1', '/tmp/a.ts', 'a', 'b');
    expect(platform.editor.diffs[0]?.request.title).toBe('[el] a.ts (Current ↔ Proposed)');
    vi.restoreAllMocks();
  });
});

describe('the approval a file change raises', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The requestPermission a call raises, with `readText` rejecting as a host does for a file it will not open as text. */
  async function approvalOf(
    toolName: 'Edit' | 'Write',
    input: (file: string) => Record<string, unknown>,
    setUp: (file: string) => void,
    readText?: (file: string) => Promise<string>,
  ): Promise<{ request: ExtensionToWebviewMessage | undefined; platform: FakePlatform }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-approval-'));
    dirs.push(dir);
    const file = path.join(dir, 'f.txt');
    setUp(file);
    const platform = createFakePlatform();
    if (readText) vi.spyOn(platform.editor, 'readText').mockImplementation(readText);
    const handler = new PermissionHandler(platform, 'host-1');
    handler.setCwd(dir);
    const messages: ExtensionToWebviewMessage[] = [];
    handler.setPostMessage((msg) => messages.push(msg));
    void handler.canUseTool(toolName, input(file), { signal: new AbortController().signal, toolUseID: 't1', parentToolUseId: null });
    await waitFor(() => handler.pendingPromptKinds().size > 0);
    return { request: messages.find((m) => m.type === 'requestPermission'), platform };
  }

  it('shows every replacement of a replace_all Edit, as Edit applies it', async () => {
    const before = ['x', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'x', ''].join('\n');
    const { request } = await approvalOf(
      'Edit',
      (file) => ({ file_path: file, old_string: 'x', new_string: 'y', replace_all: true }),
      (file) => fs.writeFileSync(file, before),
    );

    const patch = (request as { patch?: string }).patch ?? '';
    expect(patch.match(/\n-x\n\+y\n/g)).toHaveLength(2);
    expect(patch).toContain('@@ -7,5 +7,5 @@');
  });

  it.each([
    ['binary', (file: string) => fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x00, 0x01])), 'f.txt is a binary file'],
    ['tooLarge', (file: string) => fs.writeFileSync(file, Buffer.alloc(FILE_PATCH_MAX_BYTES + 1, 'x')), 'f.txt is over the size limit'],
  ])('says why a Write over a file the host will not open as text has no diff (%s), never that it creates the file', async (reason, setUp, message) => {
    const { request, platform } = await approvalOf('Write', (file) => ({ file_path: file, content: 'text\n' }), setUp, () => Promise.reject(new Error(message)));

    expect(request).toMatchObject({ toolName: 'Write', patchOmitted: reason });
    expect(request).not.toHaveProperty('patch');
    expect(platform.editor.diffs).toEqual([]);
  });

  it('treats a Write as creating its file only when the file does not exist, whatever the host\'s error says', async () => {
    const { request, platform } = await approvalOf('Write', (file) => ({ file_path: file, content: 'text\n' }), () => undefined, (file) => Promise.reject(new Error(`cannot open file://${file}`)));

    expect(request).not.toHaveProperty('patch');
    expect(request).not.toHaveProperty('patchOmitted');
    expect(platform.editor.diffs).toHaveLength(1);
  });

  it('gives a Write over an existing empty file a patch, since it does not create the file', async () => {
    const { request } = await approvalOf('Write', (file) => ({ file_path: file, content: 'text\n' }), (file) => fs.writeFileSync(file, ''));

    expect(request).toMatchObject({ patch: expect.stringContaining('@@ -0,0 +1,1 @@\n+text') });
  });
});
