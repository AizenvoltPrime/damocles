import { describe, it, expect } from 'vitest';
import { PermissionHandler } from '../index';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { CanUseToolContext } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { PermissionMode } from '../../../shared/types/settings';

const INPUT = { prompt: 'a red fox in the snow', file_path: 'assets/fox.png' };

function handlerWith(mode: PermissionMode = 'default', yolo = false): { handler: PermissionHandler; messages: ExtensionToWebviewMessage[] } {
  const handler = new PermissionHandler(createFakePlatform({ settings: { user: { 'damocles.imageGeneration.model': 'openai/gpt-image-1' } } }));
  handler.setCwd(process.cwd());
  handler.setPermissionMode(mode);
  handler.setDangerouslySkipPermissions(yolo);
  const messages: ExtensionToWebviewMessage[] = [];
  handler.setPostMessage((msg) => messages.push(msg));
  return { handler, messages };
}

function ctx(toolUseID: string, controller = new AbortController()): CanUseToolContext {
  return { signal: controller.signal, toolUseID, parentToolUseId: null };
}

describe('GenerateImage approval', () => {
  it('default mode prompts with the path, the prompt and the billed model and no diff, registered as a pending prompt', async () => {
    const { handler, messages } = handlerWith();
    const pending = handler.canUseTool('GenerateImage', INPUT, ctx('g1'));

    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toEqual({
      type: 'requestPermission',
      toolUseId: 'g1',
      toolName: 'GenerateImage',
      toolInput: INPUT,
      filePath: 'assets/fox.png',
      prompt: 'a red fox in the snow',
      imageModel: 'openai/gpt-image-1',
      owner: { kind: 'main' },
      parentToolUseId: null,
    });
    expect(handler.pendingPrompts().length > 0).toBe(true);

    await handler.resolveApproval('g1', true);
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: INPUT });
    expect(handler.pendingPrompts().length > 0).toBe(false);
  });

  it('binds the call to the model its prompt showed, even when the setting changes before the user answers', async () => {
    const platform = createFakePlatform({ settings: { user: { 'damocles.imageGeneration.model': 'openai/gpt-image-1' } } });
    const handler = new PermissionHandler(platform);
    const messages: ExtensionToWebviewMessage[] = [];
    handler.setPostMessage((msg) => messages.push(msg));
    const pending = handler.canUseTool('GenerateImage', INPUT, ctx('g9'));
    await expect.poll(() => messages.length).toBe(1);

    await platform.settings.update('damocles.imageGeneration.model', 'google/expensive-image', 'user');
    await handler.resolveApproval('g9', true);
    expect((await pending).behavior).toBe('allow');

    expect(handler.takeApprovedImageModel('g9')).toBe('openai/gpt-image-1');
    expect(handler.takeApprovedImageModel('g9')).toBeUndefined();
  });

  it('a user rejection with feedback reads as the user\'s answer', async () => {
    const { handler, messages } = handlerWith();
    const pending = handler.canUseTool('GenerateImage', INPUT, ctx('g2'));
    await expect.poll(() => messages.length).toBe(1);
    await handler.resolveApproval('g2', false, { customMessage: 'use a cat instead' });
    const result = await pending;
    expect(result.behavior).toBe('deny');
    expect(result.behavior === 'deny' && result.message).toContain('use a cat instead');
  });

  it('an abort clears the prompt and tells the webview it resolved', async () => {
    const { handler, messages } = handlerWith();
    const controller = new AbortController();
    const pending = handler.canUseTool('GenerateImage', INPUT, ctx('g3', controller));
    await expect.poll(() => messages.length).toBe(1);

    controller.abort();
    const result = await pending;
    expect(result.behavior).toBe('deny');
    expect(messages[1]).toEqual({ type: 'permissionAutoResolved', toolUseId: 'g3', parentToolUseId: null });
    expect(handler.pendingPrompts().length > 0).toBe(false);
  });

  it.each([
    ['acceptEdits', 'acceptEdits', false],
    ['YOLO', 'default', true],
  ] as const)('%s allows it without a prompt', async (_label, mode, yolo) => {
    const { handler, messages } = handlerWith(mode, yolo);
    expect(await handler.canUseTool('GenerateImage', INPUT, ctx('g4'))).toEqual({ behavior: 'allow', updatedInput: INPUT });
    expect(messages).toEqual([]);
  });

  it('a bare deny ends the turn, like any unexplained user rejection', async () => {
    const { handler } = handlerWith();
    const pending = handler.canUseTool('GenerateImage', INPUT, ctx('g5'));
    await expect.poll(() => handler.pendingPrompts().length > 0).toBe(true);
    await handler.resolveApproval('g5', false);
    expect(await pending).toMatchObject({ behavior: 'deny', interrupt: true });
  });
});
