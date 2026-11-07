// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import RewindConfirmModal from '../RewindConfirmModal.vue';
import CompactionRewindConfirm from '../CompactionRewindConfirm.vue';
import { i18n } from '@/i18n';
import { useUIStore } from '@/stores/useUIStore';
import type { ChatMessage, RewindHistoryItem, RewindOption } from '@shared/types/session';
import type { DesignChatStateView, DesignDecisionView } from '@shared/types/design';

const mounted: VueWrapper[] = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const qa = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];
// On the control that holds focus, where a user's key lands.
const press = async (key: string) => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await flush();
};
const optionLabels = () => qa('[role="option"]').map((option) => option.querySelector('.font-medium')?.textContent?.trim());
const option = (label: string) => qa('[role="option"]').find((element) => element.querySelector('.font-medium')?.textContent?.trim() === label)!;
const row = (name: string) => q(`[data-testid="rewind-design-rows"] [data-row="${name}"]`);

const DECISIONS_AFTER: DesignDecisionView[] = [
  { id: 'D2', title: 'Layout', chosen: 'Cards', rejected: ['Table'], source: { kind: 'question', ref: 'call_2' } },
  { id: 'D3', title: 'Density', chosen: 'Compact', rejected: [], source: { kind: 'chat', ref: 'u3' } },
];

const DESIGN: DesignChatStateView = {
  designId: 'contacts-1a2b3c4d', title: 'Design · Contacts', folder: '/home/u/.damocles/designs/contacts-1a2b3c4d', parentSessionId: 'parent-1',
  parentTitle: 'Contacts', status: 'finished', version: 2, fidelity: 'interactive', ruleSet: 'full', enabled: true, superseded: false, supersededBy: null,
  decisions: [{ id: 'D1', title: 'Fidelity', chosen: 'Interactive prototype', rejected: ['Static mockup'], source: { kind: 'question', ref: 'call_1' } }, ...DECISIONS_AFTER],
};

async function mountModal(props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const wrapper = mount(RewindConfirmModal, {
    props: { visible: true, canFork: true, kind: 'prompt', messagePreview: 'Try cards instead of the table', filesAffected: 1, files: [{ path: '/d/screens/S1.html', displayName: 'S1.html' }], linesChanged: { added: 4, removed: 2 }, checkpointId: 'u2', ...props },
    attachTo: document.body,
    global: { plugins: [i18n] },
  });
  mounted.push(wrapper as VueWrapper);
  await flush();
  return wrapper as VueWrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

describe('the rewind dock in a design chat', () => {
  it('shows the conversation, the decisions that go away, the design files and the main chat, with the hint', async () => {
    await mountModal({ design: DESIGN, designDecisionsAfter: DECISIONS_AFTER });

    expect(q('[role="alertdialog"]')?.textContent).toContain('Rewind the design chat');
    expect(qa('[data-testid="rewind-design-rows"] [data-row]').map((element) => element.dataset['row'])).toEqual(['conversation', 'decisions', 'files', 'main-chat']);
    expect(row('conversation')?.querySelector('dt')?.textContent?.trim()).toBe('Conversation');
    expect(row('conversation')?.querySelector('dd')?.textContent).toContain('“Try cards instead of the table”');

    const leaving = qa('[data-testid="rewind-design-decisions"] [data-testid="design-decision-chip"]');
    expect(leaving.map((chip) => chip.dataset['decisionId'])).toEqual(['D2', 'D3']);
    expect(leaving.every((chip) => chip.dataset['leaving'] === 'true')).toBe(true);
    expect(q('[data-testid="rewind-design-decisions"]')?.getAttribute('aria-label')).toBe('2 decisions go away with Rewind or Fork from here');
    expect(q('[data-testid="rewind-design-decisions-files-only"]')?.textContent).toBe('Files only keeps them.');

    expect(row('files')?.querySelector('dt')?.textContent?.trim()).toBe('Design files');
    expect(row('files')?.querySelector('dd')?.textContent).toContain('1 file affected');
    expect(row('main-chat')?.querySelector('dd')?.textContent).toContain('Keeps the last finished version');
    expect(q('[data-testid="rewind-design-version"]')?.textContent).toBe('v2');
    expect(q('[data-testid="rewind-design-hint"]')?.textContent?.trim()).toBe('Design chat checkpoints capture its design folder, not your project.');
  });

  it('says when no decision goes away, no file changed, and when the main chat has no version or the design no main chat', async () => {
    await mountModal({ design: { ...DESIGN, version: null }, designDecisionsAfter: [], filesAffected: 0, files: [] });
    expect(q('[data-testid="rewind-design-decisions-none"]')?.textContent).toBe('None go away');
    expect(q('[data-testid="rewind-design-decisions"]')).toBeNull();
    expect(row('files')?.querySelector('dd')?.textContent?.trim()).toBe('No file changes after this point');
    expect(row('main-chat')?.querySelector('dd')?.textContent?.trim()).toBe('Has no finished version yet');
    expect(q('[data-testid="rewind-design-version"]')).toBeNull();
    mounted.pop()?.unmount();

    await mountModal({ design: { ...DESIGN, parentSessionId: null, parentTitle: null }, designDecisionsAfter: [] });
    expect(row('main-chat')?.querySelector('dd')?.textContent?.trim()).toBe('No main chat');
  });

  it('marks the rows as loading until the checkpoint details arrive', async () => {
    await mountModal({ design: DESIGN, loadingMetadata: true, filesAffected: 0, files: undefined });
    expect(row('files')?.querySelector('[role="status"]')?.textContent).toBe('Loading checkpoint details…');
    expect(q('[data-testid="rewind-design-decisions-none"]')).toBeNull();
  });

  it('offers Cancel, Fork from here, Rewind and Files only, in that order, on keys 1 to 4', async () => {
    const wrapper = await mountModal({ design: DESIGN, designDecisionsAfter: DECISIONS_AFTER });
    expect(optionLabels()).toEqual(['Cancel', 'Fork from here', 'Rewind', 'Files only']);

    await press('2');
    expect(wrapper.emitted('confirm')).toEqual([['fork-conversation']]);

    await press('1');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('asks before Rewind and Files only restore the design files, naming the design folder', async () => {
    const wrapper = await mountModal({ design: DESIGN, designDecisionsAfter: DECISIONS_AFTER });

    await press('3');
    expect(q('[role="alertdialog"]')?.textContent).toContain('Restore the design files?');
    expect(q('[role="alertdialog"]')?.textContent).toContain('Your project files are not touched');
    await press('Enter');
    expect(wrapper.emitted('confirm')).toEqual([['fork-and-rewind-code']]);
    mounted.pop()?.unmount();

    const second = await mountModal({ design: DESIGN, designDecisionsAfter: DECISIONS_AFTER });
    option('Files only').click();
    await flush();
    q('[data-testid="confirm-action"]')!.click();
    await flush();
    expect(second.emitted('confirm')).toEqual([['code-only']]);
  });

  it('disables Rewind and Files only when the files cannot be restored, and Fork from here when forking is unavailable', async () => {
    await mountModal({ design: DESIGN, designDecisionsAfter: [], notRewindable: { reason: 'baselineFailed', params: { error: 'boom' } } });
    expect(qa('[role="option"]').map((element) => (element as HTMLButtonElement).disabled)).toEqual([false, false, true, true]);
    mounted.pop()?.unmount();

    await mountModal({ design: DESIGN, designDecisionsAfter: [], canFork: false });
    expect(qa('[role="option"]').map((element) => (element as HTMLButtonElement).disabled)).toEqual([false, true, true, false]);
  });
});

// The modal bound to the rewind state as App.vue binds it, so each way in opens it as the app does.
const BoundModal = defineComponent({
  props: { design: { type: Object as () => DesignChatStateView | null, default: null } },
  emits: { confirm: (_option: RewindOption) => true },
  setup(props, { emit }) {
    const ui = useUIStore();
    return () => {
      const item = ui.selectedRewindItem;
      return h(RewindConfirmModal, {
        visible: ui.showRewindTypeModal,
        canFork: ui.rewindCanFork,
        messagePreview: item?.content,
        filesAffected: item?.filesAffected,
        files: item?.files,
        linesChanged: item?.linesChanged,
        checkpointId: item?.messageId,
        loadingMetadata: ui.rewindMetadataLoading,
        design: props.design,
        designDecisionsAfter: item?.designDecisionsAfter ?? [],
        onConfirm: (option: RewindOption) => emit('confirm', option),
        onCancel: ui.cancelTypeSelection,
      });
    };
  },
});

const ITEM: RewindHistoryItem = {
  messageId: 'u2', content: 'Try cards instead of the table', timestamp: 2, filesAffected: 1,
  files: [{ path: '/d/screens/S1.html', displayName: 'S1.html' }], linesChanged: { added: 4, removed: 2 }, designDecisionsAfter: DECISIONS_AFTER,
};

async function mountBound(design: DesignChatStateView | null): Promise<VueWrapper> {
  const wrapper = mount(BoundModal, { props: { design }, attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(wrapper as VueWrapper);
  await flush();
  return wrapper as VueWrapper;
}

const focusedOption = () => (document.activeElement?.getAttribute('role') === 'option' ? document.activeElement.querySelector('.font-medium')?.textContent?.trim() : undefined);

describe.each([
  { chat: 'a design chat', design: DESIGN, first: 'Cancel', second: 'fork-conversation', arrowsTo: 'fork-conversation', arrowLabel: 'Fork from here' },
  { chat: 'any other chat', design: null, first: 'Fork conversation from here', second: 'code-only', arrowsTo: 'code-only', arrowLabel: 'Rewind code to here' },
])('the rewind dock\'s keys in $chat', ({ design, first, second, arrowsTo, arrowLabel }) => {
  it('opens from the rewind browser, its details loaded, focused on the first option, and takes 1-4, the arrows and Enter', async () => {
    const ui = useUIStore();
    ui.openRewindBrowser();
    ui.setRewindHistory([ITEM], [], true);
    ui.selectRewindItem(ITEM);
    const wrapper = await mountBound(design);

    expect(q('[aria-expanded]')).not.toBeNull();
    expect(focusedOption()).toBe(first);
    await press('ArrowDown');
    await press('ArrowDown');
    expect(focusedOption()).toBe(arrowLabel);
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
    await press('Enter');
    if (arrowsTo === 'code-only') await press('Enter');
    expect(wrapper.emitted('confirm')).toEqual([[arrowsTo]]);
    mounted.pop()?.unmount();

    ui.selectRewindItem(ITEM);
    const again = await mountBound(design);
    await press('2');
    if (second === 'code-only') await press('Enter');
    expect(again.emitted('confirm')).toEqual([[second]]);
  });

  it('opens from a message\'s Rewind before its details load, keeps focus on an option as they arrive, and takes the keys', async () => {
    const ui = useUIStore();
    ui.startDirectRewind({ id: 'm2', role: 'user', sdkMessageId: 'u2', content: ITEM.content, timestamp: 2 } as ChatMessage);
    const wrapper = await mountBound(design);
    expect(focusedOption()).toBe(first);

    ui.setRewindHistory([ITEM], [], true);
    await flush();
    expect(q('[aria-expanded]')).not.toBeNull();
    expect(focusedOption()).toBe(first);
    await press('2');
    if (second === 'code-only') await press('Enter');
    expect(wrapper.emitted('confirm')).toEqual([[second]]);
  });
});

describe('the rewind dock in any other chat', () => {
  it('keeps its own options and layout, with no design rows', async () => {
    const wrapper = await mountModal();
    expect(q('[role="alertdialog"]')?.textContent).toContain('Restore Options');
    expect(q('[data-testid="rewind-design-rows"]')).toBeNull();
    expect(q('[data-testid="rewind-design-hint"]')).toBeNull();
    expect(optionLabels()).toEqual(['Fork conversation from here', 'Rewind code to here', 'Fork conversation and rewind code', 'Cancel']);
    expect(q('[role="alertdialog"]')?.textContent).toContain('1 file affected');

    await press('2');
    expect(q('[role="alertdialog"]')?.textContent).toContain('Roll back workspace files?');
    await press('Enter');
    expect(wrapper.emitted('confirm')).toEqual([['code-only']]);
  });
});

describe('the checkpoint-less compaction fork in a design chat', () => {
  it('says the fork is a separate design started from a copy of the current files', async () => {
    const wrapper = mount(CompactionRewindConfirm, { props: { open: true, design: true }, attachTo: document.body, global: { plugins: [i18n] } });
    mounted.push(wrapper as VueWrapper);
    await flush();
    expect(q('[role="alertdialog"]')?.textContent).toContain('Fork the design from before compaction?');
    expect(q('[role="alertdialog"]')?.textContent).toContain('not linked to the main chat');
    q('[data-testid="confirm-action"]')!.click();
    expect(wrapper.emitted('confirm')).toHaveLength(1);
  });

  it('keeps its own wording in any other chat', async () => {
    mounted.push(mount(CompactionRewindConfirm, { props: { open: true }, attachTo: document.body, global: { plugins: [i18n] } }) as VueWrapper);
    await flush();
    expect(q('[role="alertdialog"]')?.textContent).toContain('Rewind to before compaction?');
  });
});
