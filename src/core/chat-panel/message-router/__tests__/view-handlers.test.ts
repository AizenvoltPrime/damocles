import { describe, expect, it, vi } from 'vitest';
import { createHandlerRegistry } from '../handler-registry';
import { MessageRouter, type MessageRouterConfig } from '..';
import type { HandlerContext, HandlerDependencies, ViewHandlerRegistry } from '../types';
import { FOREIGN_VIEW_MESSAGES, REMOTE_CHAT_SETTING_FAILURES, REMOTE_CHAT_USER_SETTING_MESSAGES, remoteChatSettingKey, USER_MEMORY_VIEW_SOURCES, VOICE_VIEW_MESSAGES } from '../../../../shared/remote-user';
import { MAX_DISABLED_TOOLS } from '../../../../shared/types/tools';
import { createFakePlatform, type FakePlatformInit } from '../../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../../__mocks__/fake-remote-host';
import type { Platform } from '../../../../platform/platform';
import type { PanelHost } from '../../../../platform/window-service';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../../shared/types/messages';

const USER_FILE = '/home/user/.damocles/settings.json';

function registry(platform: Platform) {
  const posted: ExtensionToWebviewMessage[] = [];
  const deps = { postMessage: (_host: PanelHost, message: ExtensionToWebviewMessage) => posted.push(message), platform, subscriptions: [] } as unknown as HandlerDependencies;
  return { ...createHandlerRegistry(deps), posted, deps };
}

function localPlatform(settings: FakePlatformInit['settings'] = {}) {
  return createFakePlatform({ host: 'desktop', settings: { scopeFiles: { user: USER_FILE }, ...settings } });
}

const host = {} as PanelHost;
const send = (handlers: ViewHandlerRegistry, message: Record<string, unknown>) =>
  Promise.resolve(handlers[message.type as string]!(message as unknown as WebviewToExtensionMessage, { host }));

describe("a remote chat view's messages on this computer's core", () => {
  it('each has a handler that reads only the host it replies to', () => {
    const { handlers, foreignHandlers } = registry(createFakePlatform());
    expect(Object.keys(foreignHandlers).sort()).toEqual([...FOREIGN_VIEW_MESSAGES].sort());
    for (const type of VOICE_VIEW_MESSAGES) expect(handlers[type], type).toBe(foreignHandlers[type]);
    // the chat's own setters write where its value is read; a remote chat's go to this computer's user file alone
    for (const type of REMOTE_CHAT_USER_SETTING_MESSAGES) expect(handlers[type], type).not.toBe(foreignHandlers[type]);
    // a chat's own read replies to the asking view, a remote chat's to the foreign host it came through
    expect(handlers['requestSubscriptionUsage']).toBeTypeOf('function');
    // a local chat's popup manages this computer's memories with its own types; these reach this core only from a remote chat's page
    for (const type of Object.keys(USER_MEMORY_VIEW_SOURCES)) expect(handlers[type], type).toBeUndefined();
    const handler: ViewHandlerRegistry[string] = (_message, ctx) => {
      // @ts-expect-error no chat of this core stands behind a remote chat's view
      void ctx.session;
    };
    expect(handler).toBeTypeOf('function');
  });

  it('dispatchForeign takes a user-scope read and refuses every other message', async () => {
    const platform = createFakePlatform();
    const router = new MessageRouter({ postMessage: () => undefined, platform, subscriptions: [], getPanels: () => new Map() } as unknown as MessageRouterConfig);
    const usage = vi.fn();
    (router as unknown as { foreignHandlers: ViewHandlerRegistry }).foreignHandlers.requestSubscriptionUsage = usage;
    await router.dispatchForeign(host, { type: 'requestSubscriptionUsage' }, 'view-1');
    expect(usage).toHaveBeenCalledWith({ type: 'requestSubscriptionUsage' }, { host, viewId: 'view-1' });
    const userMemories = vi.fn();
    (router as unknown as { foreignHandlers: ViewHandlerRegistry }).foreignHandlers.pinUserMemory = userMemories;
    await router.dispatchForeign(host, { type: 'pinUserMemory', id: 'm1' }, 'view-1');
    expect(userMemories).toHaveBeenCalledWith({ type: 'pinUserMemory', id: 'm1' }, { host, viewId: 'view-1' });
    await expect(router.dispatchForeign(host, { type: 'requestMemories' } as WebviewToExtensionMessage, 'view-1')).rejects.toThrow('does not reach this computer');
    await expect(router.dispatchForeign(host, { type: 'pinMemory', id: 'm1' } as WebviewToExtensionMessage, 'view-1')).rejects.toThrow('does not reach this computer');
    await expect(router.dispatchForeign(host, { type: 'setPermissionMode', mode: 'default' } as WebviewToExtensionMessage, 'view-1')).rejects.toThrow('does not reach this computer');
    await expect(router.dispatchForeign(host, { type: 'constructor' } as unknown as WebviewToExtensionMessage, 'view-1')).rejects.toThrow('does not reach this computer');
  });
});

describe("a remote chat view's user-setting writes on this computer's core", () => {
  it('write the user file even when the default project file holds the key, and report that file', async () => {
    const platform = localPlatform({ project: { 'damocles.compass.enabled': false, 'damocles.pinnedHeaderHidden': false } });
    const { foreignHandlers, posted } = registry(platform);
    await send(foreignHandlers, { type: 'toggleToolGroup', group: 'compass', enabled: true });
    await send(foreignHandlers, { type: 'setPinnedHeaderHidden', hidden: true });
    expect(platform.settings.inspect('damocles.compass.enabled')).toMatchObject({ userValue: true, projectValue: false });
    expect(platform.settings.inspect('damocles.pinnedHeaderHidden')).toMatchObject({ userValue: true, projectValue: false });
    expect(posted).toEqual([
      { type: 'settingWriteResult', key: 'damocles.compass.enabled', ok: true, scope: 'user', file: USER_FILE },
      { type: 'settingWriteResult', key: 'damocles.pinnedHeaderHidden', ok: true, scope: 'user', file: USER_FILE },
    ]);
  });

  it('toggleTool builds the list from the user layer alone', async () => {
    const platform = localPlatform({ user: { 'damocles.tools.disabled': ['A'] }, project: { 'damocles.tools.disabled': ['P'] } });
    const { foreignHandlers } = registry(platform);
    await send(foreignHandlers, { type: 'toggleTool', toolName: 'B', enabled: false });
    await send(foreignHandlers, { type: 'toggleTool', toolName: 'A', enabled: true });
    expect(platform.settings.inspect('damocles.tools.disabled')).toMatchObject({ userValue: ['B'], projectValue: ['P'] });
  });

  it('toggleTool keeps every other entry of the list as it is, one that is not a name included', async () => {
    const platform = localPlatform({ user: { 'damocles.tools.disabled': ['A', 7, { uri: 'file:///x' }] } });
    const { foreignHandlers } = registry(platform);
    await send(foreignHandlers, { type: 'toggleTool', toolName: 'B', enabled: false });
    await send(foreignHandlers, { type: 'toggleTool', toolName: 'A', enabled: true });
    expect(platform.settings.inspect('damocles.tools.disabled').userValue).toEqual([7, { uri: 'file:///x' }, 'B']);
  });

  it('toggleTool refuses to turn one more tool off past the bound, and still turns one on', async () => {
    const full = Array.from({ length: MAX_DISABLED_TOOLS }, (_, index) => `T${index}`);
    const platform = localPlatform({ user: { 'damocles.tools.disabled': full } });
    const { foreignHandlers, posted } = registry(platform);
    await send(foreignHandlers, { type: 'toggleTool', toolName: 'New', enabled: false });
    expect(platform.settings.inspect('damocles.tools.disabled').userValue).toEqual(full);
    expect(posted).toEqual([
      { type: 'notification', notificationType: 'error', message: { message: 'Failed to save tool setting: {0}', args: [{ message: 'At most {0} tools can be turned off. Turn one back on first.', args: [MAX_DISABLED_TOOLS] }] } },
      { type: 'settingWriteResult', key: 'damocles.tools.disabled', ok: false, error: { message: 'At most {0} tools can be turned off. Turn one back on first.', args: [MAX_DISABLED_TOOLS] } },
    ]);
    await send(foreignHandlers, { type: 'toggleTool', toolName: 'T0', enabled: true });
    expect(platform.settings.inspect('damocles.tools.disabled').userValue).toEqual(full.slice(1));
  });

  it('report each write under the key and toast wording main gives one this core never answered', async () => {
    const platform = localPlatform();
    vi.spyOn(platform.settings, 'update').mockRejectedValue(new Error('EACCES'));
    const { foreignHandlers, posted } = registry(platform);
    const writes = [
      { type: 'setPinnedHeaderHidden', hidden: true },
      { type: 'toggleToolGroup', group: 'web', enabled: true },
      { type: 'toggleTool', toolName: 'A', enabled: false },
    ] as const;
    for (const write of writes) await send(foreignHandlers, write);
    expect(posted).toEqual(writes.flatMap((write) => [
      { type: 'notification', notificationType: 'error', message: expect.objectContaining({ message: REMOTE_CHAT_SETTING_FAILURES[write.type] }) },
      { type: 'settingWriteResult', key: remoteChatSettingKey(write.type, 'group' in write ? write.group : undefined), ok: false, error: expect.anything() },
    ]));
  });

  it.each([
    { type: 'setPinnedHeaderHidden', hidden: 'yes' },
    { type: 'toggleToolGroup', group: 'core', enabled: true },
    { type: 'toggleToolGroup', group: 'constructor', enabled: true },
    { type: 'toggleToolGroup', group: 'compass', enabled: 1 },
    { type: 'toggleTool', toolName: '', enabled: false },
    { type: 'toggleTool', toolName: 'x'.repeat(257), enabled: false },
    { type: 'toggleTool', toolName: 7, enabled: false },
    { type: 'toggleTool', toolName: 'A', enabled: 'no' },
  ])('refuse malformed arguments before any write: %o', async (message) => {
    const platform = localPlatform();
    const update = vi.spyOn(platform.settings, 'update');
    const { foreignHandlers, posted } = registry(platform);
    await expect(send(foreignHandlers, message)).rejects.toThrow(/Malformed/);
    expect(update).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it.each([
    { type: 'toggleToolGroup', group: 'core', enabled: true },
    { type: 'toggleToolGroup', group: 'compass', enabled: 'on' },
    { type: 'toggleTool', toolName: '', enabled: false },
    { type: 'toggleTool', toolName: 'x'.repeat(257), enabled: false },
    { type: 'toggleTool', toolName: 'A', enabled: 0 },
  ])('the chat\'s own switch refuses the same malformed arguments before any write: %o', async (message) => {
    const platform = localPlatform();
    const update = vi.spyOn(platform.settings, 'update');
    const { handlers, posted } = registry(platform);
    const ctx = { host, reply: host, folder: { key: 'f', fsPath: '/w', name: 'w', label: 'w', projectScope: true } } as unknown as HandlerContext;
    await expect(Promise.resolve(handlers[message.type]!(message as unknown as WebviewToExtensionMessage, ctx))).rejects.toThrow(/Malformed/);
    expect(update).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it('report a failed write with ok:false and the toast', async () => {
    const platform = localPlatform();
    vi.spyOn(platform.settings, 'update').mockRejectedValue(new Error('EACCES: settings.json is read-only'));
    const { foreignHandlers, posted } = registry(platform);
    await send(foreignHandlers, { type: 'toggleTool', toolName: 'A', enabled: false });
    expect(posted).toEqual([
      { type: 'notification', notificationType: 'error', message: expect.objectContaining({ message: 'Failed to save tool setting: {0}' }) },
      { type: 'settingWriteResult', key: 'damocles.tools.disabled', ok: false, error: expect.anything() },
    ]);
  });

  it('refuse on a daemon\'s core, which holds no user file of this computer', async () => {
    const remote = createFakeRemoteHost();
    const platform = { ...localPlatform(), remote: remote.remote };
    const update = vi.spyOn(platform.settings, 'update');
    const { foreignHandlers, posted } = registry(platform);
    await send(foreignHandlers, { type: 'setPinnedHeaderHidden', hidden: true });
    await send(foreignHandlers, { type: 'toggleToolGroup', group: 'browser', enabled: true });
    await send(foreignHandlers, { type: 'toggleTool', toolName: 'A', enabled: false });
    expect(update).not.toHaveBeenCalled();
    expect(posted.filter((message) => message.type === 'notification')).toHaveLength(3);
    expect(posted.filter((message) => message.type === 'settingWriteResult')).toEqual([
      expect.objectContaining({ key: 'damocles.pinnedHeaderHidden', ok: false }),
      expect.objectContaining({ key: 'damocles.browser.enabled', ok: false }),
      expect.objectContaining({ key: 'damocles.tools.disabled', ok: false }),
    ]);
    expect(remote.remote.credentials).not.toHaveBeenCalled();
  });
});
