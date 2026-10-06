// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import PermissionPrompt from '../PermissionPrompt.vue';
import { useDiffStore } from '@/stores/useDiffStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useOverlayEscape } from '@/composables/useOverlayEscape';
import type { PermissionUpdate, PromptOwner } from '@shared/types/permissions';
import { i18n } from '@/i18n';

/**
 * Keys 1..n answer the lone permission card from anywhere in the panel, but a digit typed into the composer
 * or the card's own feedback box is text, never a decision.
 */

const mounted: VueWrapper[] = [];

/** Line 1 kept and two lines added after it: the patch an approval of that change carries. */
const PATCH = '--- src/a.ts\n+++ src/a.ts\n@@ -1,1 +1,3 @@\n a\n+b\n+c\n';

const SUGGESTION: PermissionUpdate = { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] };

function card(props: Record<string, unknown> = {}): VueWrapper {
  const wrapper = mount(PermissionPrompt, {
    props: { visible: true, toolUseId: 'p-1', toolName: 'Edit', filePath: 'src/a.ts', patch: PATCH, ...props },
    global: { plugins: [i18n], stubs: { PermissionDestinationPicker: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

function press(key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => setActivePinia(createPinia()));

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

describe('the numbered permission card', () => {
  it('answers Yes, Yes and accept all, and No with 1, 2 and 3 from anywhere outside an editable field', () => {
    const wrapper = card();

    press('1');
    press('2');
    press('3');

    expect(wrapper.emitted('approve')).toEqual([[true], [true, { acceptAll: true }], [false]]);
  });

  it('numbers the options in order, so a suggested rule shifts No to 3 on a shell prompt', async () => {
    const wrapper = card({ toolName: 'Bash', command: 'ls', patch: undefined, suggestions: [SUGGESTION] });

    press('3');

    expect(wrapper.emitted('approve')).toEqual([[false]]);
    expect(wrapper.get('[data-testid="permission-option-always-allow"]').text()).toContain('2');
    expect(wrapper.get('[data-testid="permission-option-always-deny"]').text()).toContain('4');
  });

  it('ignores digits typed into the composer', () => {
    const wrapper = card();
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);

    press('1', composer);
    press('3', composer);

    expect(wrapper.emitted('approve')).toBeUndefined();
  });

  it('ignores digits typed into its own feedback box', () => {
    const wrapper = card();

    press('2', wrapper.get('[data-testid="permission-feedback"]').element);

    expect(wrapper.emitted('approve')).toBeUndefined();
  });

  it('answers while its own options hold focus', () => {
    const wrapper = card();
    const options = wrapper.get('[data-testid="permission-options"]').element as HTMLElement;

    press('1', options);

    expect(wrapper.emitted('approve')).toEqual([[true]]);
  });

  it('leaves a modified digit alone, so shortcuts such as Ctrl+1 keep working', () => {
    const wrapper = card();

    press('1', document.body, { ctrlKey: true });

    expect(wrapper.emitted('approve')).toBeUndefined();
  });

  it('ignores a held digit, so auto-repeat never answers the next queued card', () => {
    const wrapper = card();

    press('1', document.body, { repeat: true });

    expect(wrapper.emitted('approve')).toBeUndefined();
  });

  it.each([
    ['an open menu', 'role', 'menu'],
    ['an open popover', 'data-dismissable-layer', ''],
    ['a listbox such as the prompt navigator', 'role', 'listbox'],
  ])('leaves a digit typed in %s to that widget', (_name, attribute, value) => {
    const wrapper = card();
    const widget = document.createElement('div');
    widget.setAttribute(attribute, value);
    const item = document.createElement('div');
    item.tabIndex = 0;
    widget.appendChild(item);
    document.body.appendChild(widget);

    press('1', item);

    expect(wrapper.emitted('approve')).toBeUndefined();
  });

  it('stays quiet while an overlay covers it', () => {
    const wrapper = card();
    const overlay = mount(defineComponent({ setup() { useOverlayEscape(() => undefined); return () => h('div'); } }), { attachTo: document.body });
    mounted.push(overlay);

    press('1');

    expect(wrapper.emitted('approve')).toBeUndefined();
  });

  it('never answers on Shift+Tab, which keeps moving focus backwards, and offers no hint for it', () => {
    const wrapper = card();
    const options = wrapper.get('[data-testid="permission-options"]').element as HTMLElement;

    const event = press('Tab', options, { shiftKey: true });

    expect(wrapper.emitted('approve')).toBeUndefined();
    expect(event.defaultPrevented).toBe(false);
    expect(wrapper.text()).not.toContain('Shift+Tab');
  });

  it('takes Escape as No while the options hold focus, and keeps Escape from interrupting the run', () => {
    const wrapper = card();
    const options = wrapper.get('[data-testid="permission-options"]').element as HTMLElement;
    const reachedWindow: string[] = [];
    const onWindow = (e: KeyboardEvent) => { reachedWindow.push(e.key); };
    window.addEventListener('keydown', onWindow);

    press('Escape', options);
    window.removeEventListener('keydown', onWindow);

    expect(wrapper.emitted('approve')).toEqual([[false]]);
    expect(reachedWindow).not.toContain('Escape');
  });

  it('sends Escape in the feedback box back to the options, answering nothing and never reaching the run', () => {
    const wrapper = card();
    const feedback = wrapper.get('[data-testid="permission-feedback"]').element as HTMLInputElement;
    feedback.focus();
    const reachedWindow: string[] = [];
    const onWindow = (e: KeyboardEvent) => { reachedWindow.push(e.key); };
    window.addEventListener('keydown', onWindow);

    press('Escape', feedback);
    window.removeEventListener('keydown', onWindow);

    expect(wrapper.emitted('approve')).toBeUndefined();
    expect(reachedWindow).not.toContain('Escape');
    expect(wrapper.get('[data-testid="permission-options"]').element.contains(document.activeElement)).toBe(true);
  });

  it('sends what the user typed as the reason to do something else', async () => {
    const wrapper = card();
    const input = wrapper.get('[data-testid="permission-feedback"]');

    await input.setValue('use a branch');
    await input.trigger('keydown', { key: 'Enter' });

    expect(wrapper.emitted('approve')).toEqual([[false, { customMessage: 'use a branch' }]]);
  });
});

describe('Yes, and accept all edits this session', () => {
  const TEAM: PromptOwner = { kind: 'team', teamId: 'team-1', agentId: 'agent-1', teamTitle: 'Lockout', agentName: 'Mira' };
  const SUBAGENT: PromptOwner = { kind: 'subagent', agentId: 'sub-1' };
  const optionValues = (wrapper: VueWrapper) => wrapper.findAll('[role="option"]').map((o) => o.attributes('data-testid')!.replace('permission-option-', ''));

  it.each(['Edit', 'Write', 'GenerateImage'])('is offered on a %s prompt from the chat, a subagent or a team agent in default mode, as option 2', (toolName) => {
    for (const owner of [{ kind: 'main' } as const, SUBAGENT, TEAM]) {
      expect(optionValues(card({ toolName, owner }))).toEqual(['yes', 'yes-accept-all', 'no']);
    }
  });

  it.each(['Bash', 'PowerShell'])('is never offered on a %s prompt, whose 2 then answers No', (toolName) => {
    const wrapper = card({ toolName, command: 'ls', patch: undefined, owner: TEAM });

    expect(optionValues(wrapper)).toEqual(['yes', 'no']);
    expect(wrapper.get('[data-testid="permission-option-no"]').attributes('aria-keyshortcuts')).toBe('2 Escape');
    press('2');
    expect(wrapper.emitted('approve')).toEqual([[false]]);
  });

  it('is never offered on a tool with no view of its own, which acceptEdits never approves', () => {
    expect(optionValues(card({ toolName: 'Read', toolInput: { file_path: '.env' }, patch: undefined }))).toEqual(['yes', 'no']);
  });

  it.each(['plan', 'acceptEdits'] as const)("is not offered on any agent's edit in %s mode, where switching the chat to acceptEdits would leave plan mode or change nothing", (mode) => {
    useSettingsStore().setPermissionMode(mode);

    for (const owner of [{ kind: 'main' } as const, SUBAGENT, TEAM]) {
      expect(optionValues(card({ owner }))).toEqual(['yes', 'no']);
    }
  });
});

describe('what the card says about the change', () => {
  it('asks to allow the edit and names the file with the lines it adds', () => {
    const wrapper = card();

    expect(wrapper.get('[data-testid="permission-title"]').text()).toBe('Allow this edit?');
    expect(wrapper.get('[data-testid="permission-subtitle"]').text()).toBe('src/a.ts · +2 lines');
  });

  it('names a file inside the chat folder by its relative path, with the full path in the tooltip', () => {
    useSettingsStore().setWorkspaceFolders([{ key: 'k', name: 'proj', label: 'proj', path: '/home/a/proj' }], 'k', 'k');
    const wrapper = card({ filePath: '/home/a/proj/src/a.ts' });

    const subtitle = wrapper.get('[data-testid="permission-subtitle"]');
    expect(subtitle.text()).toBe('src/a.ts · +2 lines');
    expect(subtitle.attributes('title')).toBe('/home/a/proj/src/a.ts · +2 lines');
  });

  it('asks to allow creating a new file and counts its lines', () => {
    const wrapper = card({ toolName: 'Write', toolInput: { file_path: 'src/a.ts', content: 'x\ny\n' }, patch: undefined });

    expect(wrapper.get('[data-testid="permission-title"]').text()).toBe('Allow creating this file?');
    expect(wrapper.get('[data-testid="permission-subtitle"]').text()).toContain('src/a.ts');
  });

  it('asks to allow editing, not creating, a file the approval could not diff', () => {
    const wrapper = card({ toolName: 'Write', toolInput: { file_path: 'src/a.bin', content: 'x\n' }, filePath: 'src/a.bin', patch: undefined, patchOmitted: 'binary' });

    expect(wrapper.get('[data-testid="permission-title"]').text()).toBe(i18n.global.t('prompts.permission.allowEdit'));
    expect(wrapper.get('[data-testid="permission-subtitle"]').text()).toBe('src/a.bin');
  });

  it('still shows the card when the approval\'s patch does not parse, with the change unnumbered', () => {
    const wrapper = card({ toolName: 'Write', toolInput: { file_path: 'src/a\nb.ts', content: 'x\n' }, patch: '--- src/a\nb.ts\n+++ src/a\nb.ts\n@@ -1,1 +1,1 @@\n-y\n+x\n' });

    expect(wrapper.get('[data-testid="permission-title"]').text()).toBe(i18n.global.t('prompts.permission.allowEdit'));
    expect(wrapper.get('[data-testid="permission-subtitle"]').text()).toContain('+1 line');
  });

  it('keeps the digit and hint out of the option names and announces them as key shortcuts', () => {
    const wrapper = card();
    const yes = wrapper.get('[data-testid="permission-option-yes"]');

    expect(yes.attributes('aria-keyshortcuts')).toBe('1 Enter');
    expect(wrapper.get('[data-testid="permission-option-yes-accept-all"]').attributes('aria-keyshortcuts')).toBe('2');
    expect(wrapper.get('[data-testid="permission-option-no"]').attributes('aria-keyshortcuts')).toBe('3 Escape');
    for (const hidden of yes.findAll('[aria-hidden="true"]')) expect(['1', 'Enter']).toContain(hidden.text());
  });

  it('opens the Monaco proposal the host sent for this card on desktop', async () => {
    const settingsStore = useSettingsStore();
    settingsStore.setHostCapabilities({ ...settingsStore.hostCapabilities, monaco: true });
    const editorStore = useEditorStore();
    const doc = (content: string) => ({ name: 'a.ts', body: { kind: 'text' as const, content, languageId: 'typescript' } });
    editorStore.showDiff({ type: 'editorShowDiff', viewId: 'v1', title: 'a.ts', purpose: 'proposal', approvalId: 'p-1', original: doc('a'), modified: doc('b') });
    expect(editorStore.view).toBeNull();
    const wrapper = card();

    await wrapper.get('[data-testid="permission-open-diff"]').trigger('click');

    expect(editorStore.view).toMatchObject({ viewId: 'v1', purpose: 'proposal', approvalId: 'p-1' });
    expect(useDiffStore().expandedDiff).toBeNull();
  });

  it('opens the diff in the panel without a message', async () => {
    const wrapper = card();

    await wrapper.get('[data-testid="permission-open-diff"]').trigger('click');

    expect(useDiffStore().expandedDiff).toEqual({ filePath: 'src/a.ts', tool: 'Edit', source: { kind: 'patch', patch: PATCH } });
  });

  it('shows the command for a shell call and offers no diff', () => {
    const wrapper = card({ toolName: 'Bash', command: 'rm -rf build', patch: undefined });

    expect(wrapper.get('[data-testid="permission-title"]').text()).toBe(i18n.global.t('permission.runCommand'));
    expect(wrapper.text()).toContain('rm -rf build');
    expect(wrapper.find('[data-testid="permission-open-diff"]').exists()).toBe(false);
  });
});
