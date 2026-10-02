import { describe, it, expect, vi } from 'vitest';
import { PermissionHandler } from '../index';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { CanUseToolContext } from '../types';
import { DiffManager } from '../diff-manager';
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
    await waitFor(() => handler.hasPendingPrompts());

    expect(platform.editor.diffs[0]?.request).toMatchObject({ purpose: 'proposal', panelId: 'host-7', approvalId: 't1' });
  });

  it.each([
    ['approve', true],
    ['reject', false],
  ])('closes when the user decides (%s)', async (_label, approved) => {
    const { handler, platform } = handlerFor('host-1');
    const decision = requestEdit(handler, 't1');
    await waitFor(() => handler.hasPendingPrompts());

    await handler.resolveApproval('t1', approved);

    await expect(decision).resolves.toMatchObject({ behavior: approved ? 'allow' : 'deny' });
    expect(platform.editor.diffs[0]?.closeCalls).toBe(1);
  });

  it('closes when the tool call is aborted', async () => {
    const { handler, platform } = handlerFor('host-1');
    const controller = new AbortController();
    const decision = requestEdit(handler, 't1', controller.signal);
    await waitFor(() => handler.hasPendingPrompts());

    controller.abort();
    await decision;

    expect(platform.editor.diffs[0]?.closeCalls).toBe(1);
  });

  it('closes when the panel is disposed', async () => {
    const { handler, platform } = handlerFor('host-1');
    void requestEdit(handler, 't1');
    await waitFor(() => handler.hasPendingPrompts());

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
