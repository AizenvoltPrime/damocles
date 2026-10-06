// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { PromptOwner } from '@shared/types/permissions';
import { i18n } from '@/i18n';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

let app: VueWrapper | null = null;
let posted: { type: string }[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const SUBAGENT: PromptOwner = { kind: 'subagent', agentId: 'agent-call-1' };
const TEAM: PromptOwner = { kind: 'team', teamId: 'team-1', agentId: 'team-agent-1', teamTitle: 'Lockout', agentName: 'Mira' };

describe("Yes, and accept all edits on a nested agent's Edit prompt", () => {
  it.each([
    ['a subagent', SUBAGENT, 'agent-call-1'],
    ['a team agent', TEAM, 'team-agent-1'],
  ])("on %s's prompt switches the whole chat to acceptEdits before approving the call", async (_label, owner, parentToolUseId) => {
    useSettingsStore().setPermissionMode('default');
    usePermissionStore().addPermission('e1', {
      owner,
      parentToolUseId,
      toolName: 'Edit',
      toolInput: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
      filePath: 'src/a.ts',
    });
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    await nextTick();

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }));
    await nextTick();

    expect(posted.filter((m) => m.type === 'setPermissionMode' || m.type === 'approveEdit')).toStrictEqual([
      { type: 'setPermissionMode', mode: 'acceptEdits' },
      { type: 'approveEdit', toolUseId: 'e1', approved: true },
    ]);
    expect(useSettingsStore().currentSettings.permissionMode).toBe('acceptEdits');
  });
});
