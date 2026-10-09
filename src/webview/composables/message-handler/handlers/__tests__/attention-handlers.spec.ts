// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineAsyncComponent, defineComponent, h, nextTick, ref } from 'vue';
import SkillApprovalPrompt from '@/components/SkillApprovalPrompt.vue';
import FormPrompt from '@/components/FormPrompt.vue';
import { createAttentionHandlers } from '../attention-handlers';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useQuestionStore } from '@/stores/useQuestionStore';
import { useFormStore } from '@/stores/useFormStore';
import { useElicitationStore } from '@/stores/useElicitationStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { useSubscriptionUsageStore } from '@/stores/useSubscriptionUsageStore';
import { useContextUsageStore } from '@/stores/useContextUsageStore';
import { useUsageStatsStore } from '@/stores/useUsageStatsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { HandlerContext } from '../../types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';
import { i18n } from '@/i18n';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m), onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const mounted: VueWrapper[] = [];
const prependInput = vi.fn();

function context(): HandlerContext {
  return {
    stores: {
      permissionStore: usePermissionStore(),
      questionStore: useQuestionStore(),
      formStore: useFormStore(),
      elicitationStore: useElicitationStore(),
      teamStore: useTeamStore(),
      subscriptionUsageStore: useSubscriptionUsageStore(),
      contextUsageStore: useContextUsageStore(),
      uiStore: useUIStore(),
    },
    refs: { chatInputRef: ref({ prependInput }) },
    bridge: { postMessage: (m: WebviewToExtensionMessage) => posted.push(m) },
  } as unknown as HandlerContext;
}

function dispatch(msg: ExtensionToWebviewMessage): void {
  const handler = createAttentionHandlers()[msg.type] as ((m: ExtensionToWebviewMessage, c: HandlerContext) => void) | undefined;
  if (!handler) throw new Error(`no handler for ${msg.type}`);
  handler(msg, context());
}

/** The composer holds focus, so a card mounting now keeps its options' focus back. */
function composer(): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  textarea.focus();
  return textarea;
}

async function skillCard(): Promise<VueWrapper> {
  usePermissionStore().setPendingSkillApproval({ toolUseId: 's-1', skillName: 'deploy' });
  const wrapper = mount(SkillApprovalPrompt, { props: { visible: true, skillName: 'deploy' }, global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

const FORM = { toolUseId: 'f-1', form: { title: 'Log in', fields: [{ id: 'user', label: 'User', type: 'text' as const, selector: '#user' }] } };

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
  prependInput.mockClear();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

describe('focusAttention', () => {
  it('focuses an approval card\'s options although the composer held focus as it mounted, and rings the card', async () => {
    const textarea = composer();
    const card = await skillCard();
    expect(document.activeElement).toBe(textarea);

    dispatch({ type: 'focusAttention', kind: 'approval' });
    await flushPromises();

    expect(document.activeElement?.getAttribute('role')).toBe('option');
    expect(card.element.contains(document.activeElement)).toBe(true);
    expect(card.element.classList.contains('d-attention')).toBe(true);
  });

  it('focuses an input form for a question when no question card is up', async () => {
    composer();
    useFormStore().setForm(FORM);
    const card = mount(FormPrompt, { props: { visible: true }, global: { plugins: [i18n] }, attachTo: document.body });
    mounted.push(card);
    await flushPromises();
    (document.body.querySelector('textarea') as HTMLElement).focus();

    dispatch({ type: 'focusAttention', kind: 'question' });
    await flushPromises();

    expect(document.activeElement?.tagName).toBe('INPUT');
    expect(card.element.contains(document.activeElement)).toBe(true);
    expect(card.element.classList.contains('d-attention')).toBe(true);
  });

  it('reaches a card that was still mounting when the request came, while its prompt is pending', async () => {
    composer();
    usePermissionStore().setPendingSkillApproval({ toolUseId: 's-1', skillName: 'deploy' });
    let release: () => void = () => {};
    const Loading = defineAsyncComponent(() => new Promise<typeof SkillApprovalPrompt>((resolve) => { release = () => resolve(SkillApprovalPrompt); }));
    const host = mount(defineComponent({ render: () => h(Loading, { visible: true, skillName: 'deploy' }) }), { global: { plugins: [i18n] }, attachTo: document.body });
    mounted.push(host);

    dispatch({ type: 'focusAttention', kind: 'approval' });
    release();
    await flushPromises();
    await nextTick();
    await flushPromises();

    expect(document.activeElement?.getAttribute('role')).toBe('option');
  });

  it('does nothing with no card and nothing pending', async () => {
    const textarea = composer();

    dispatch({ type: 'focusAttention', kind: 'approval' });
    dispatch({ type: 'focusAttention', kind: 'question' });
    dispatch({ type: 'focusAttention', kind: 'plan' });
    await flushPromises();

    expect(document.activeElement).toBe(textarea);
    expect(usePermissionStore().isPlanOverlayVisible).toBe(false);
  });

  it('opens the plan review as the banner does', () => {
    const permissionStore = usePermissionStore();
    permissionStore.setPendingPlanApproval({ toolUseId: 'p-1', planContent: '1. Ship', planVersion: 2 });
    permissionStore.hidePlanOverlay();

    dispatch({ type: 'focusAttention', kind: 'plan' });

    expect(permissionStore.isPlanOverlayVisible).toBe(true);
  });
});

describe('openTeamOverlay', () => {
  it('opens a known team\'s overlay and ignores an unknown team', () => {
    const teamStore = useTeamStore();
    teamStore.registerTeamFromTool('tool-1', { title: 'Auth', agents: [{ name: 'Lead', role: 'lead' }] });
    const teamId = Object.keys(teamStore.teams)[0]!;

    dispatch({ type: 'openTeamOverlay', teamId: 'team-missing' });
    expect(teamStore.isOverlayOpen).toBe(false);

    dispatch({ type: 'openTeamOverlay', teamId });
    expect(teamStore.isOverlayOpen).toBe(true);
    expect(teamStore.selectedTeamId).toBe(teamId);
  });
});

describe('runChatCommand', () => {
  it('opens Subscription usage and asks the host for it, as /usage does', () => {
    dispatch({ type: 'runChatCommand', command: 'subscriptionUsage' });

    expect(useSubscriptionUsageStore().isOverlayOpen).toBe(true);
    expect(posted).toEqual([{ type: 'requestSubscriptionUsage' }]);
  });

  it('opens Context usage and asks the host for it, as the header does', () => {
    dispatch({ type: 'runChatCommand', command: 'contextUsage' });
    expect(useContextUsageStore().isOverlayOpen).toBe(true);
    expect(posted).toEqual([{ type: 'requestContextUsage' }]);
  });

  it('opens Usage statistics', () => {
    dispatch({ type: 'runChatCommand', command: 'usageStatistics' });
    expect(useUsageStatsStore().isOverlayOpen).toBe(true);
  });

  it('opens MCP servers and asks for their status', () => {
    dispatch({ type: 'runChatCommand', command: 'mcpServers' });
    expect(useUIStore().showMcpPanel).toBe(true);
    expect(posted).toEqual([{ type: 'requestMcpStatus' }]);
  });

  it('opens Tools and asks for their status', () => {
    dispatch({ type: 'runChatCommand', command: 'tools' });
    expect(useUIStore().showToolsPanel).toBe(true);
    expect(posted).toEqual([{ type: 'requestToolStatus' }]);
  });

  it('opens Memory', () => {
    dispatch({ type: 'runChatCommand', command: 'memory' });
    expect(useUIStore().showMemoryPanel).toBe(true);
  });

  it('opens the rewind browser and asks for the rewind history', () => {
    dispatch({ type: 'runChatCommand', command: 'rewind' });
    expect(useUIStore().showRewindBrowser).toBe(true);
    expect(posted).toEqual([{ type: 'requestRewindHistory' }]);
  });

  it('starts a side question in the composer, as the header does', () => {
    dispatch({ type: 'runChatCommand', command: 'sideQuestion' });
    expect(prependInput).toHaveBeenCalledWith('/btw ');
  });

  it('opens the session log and the session plan through the host', () => {
    dispatch({ type: 'runChatCommand', command: 'openSessionLog' });
    dispatch({ type: 'runChatCommand', command: 'viewSessionPlan' });
    expect(posted).toEqual([{ type: 'openSessionLog' }, { type: 'openSessionPlan' }]);
  });
});
