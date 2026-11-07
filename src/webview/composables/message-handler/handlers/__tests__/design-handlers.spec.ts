// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { DesignChatStateView, DesignLinkStateView, DesignResultView } from '@shared/types/design';
import { useDesignStore } from '@/stores/useDesignStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useQuestionStore } from '@/stores/useQuestionStore';
import { useFormStore } from '@/stores/useFormStore';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { usePlanViewStore } from '@/stores/usePlanViewStore';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import { useContextUsageStore } from '@/stores/useContextUsageStore';
import { useSubscriptionUsageStore } from '@/stores/useSubscriptionUsageStore';
import { useElicitationStore } from '@/stores/useElicitationStore';
import { useBtwStore } from '@/stores/useBtwStore';
import { i18n } from '@/i18n';
import { createHandlerRegistry } from '../../handler-registry';
import type { HandlerContext, HandlerRegistry, StoreContext } from '../../types';

vi.mock('vue-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const DESIGN: DesignChatStateView = {
  designId: 'contacts-1a2b3c4d',
  title: 'Design · Contacts',
  folder: '~/.damocles/designs/contacts-1a2b3c4d',
  parentSessionId: 'parent-1',
  parentTitle: 'Contacts',
  status: 'draft',
  version: null,
  fidelity: 'interactive',
  decisions: [{ id: 'D1', title: 'Fidelity', chosen: 'Interactive prototype', rejected: ['Static mockup'], source: { kind: 'question', ref: 'call_1' } }],
  ruleSet: 'full',
  enabled: true,
  superseded: false,
  supersededBy: null,
};
const LINK: DesignLinkStateView = { designId: DESIGN.designId, title: 'Contacts', folder: DESIGN.folder, designSessionId: 'design-1', status: 'finished', version: 1 };
const RESULT: DesignResultView = {
  designId: DESIGN.designId, version: 1, folder: DESIGN.folder, title: 'Contacts', screens: ['S1'], decisions: [{ id: 'D1', title: 'Fidelity', chosen: 'Interactive prototype' }],
  check: { errors: 0, warnings: [] }, journeys: [], previousVersion: null, changes: [],
};

let ctx: HandlerContext;
let registry: HandlerRegistry;

function context(): HandlerContext {
  const stores = {
    uiStore: useUIStore(), streamingStore: useStreamingStore(), sessionStore: useSessionStore(), subagentStore: useSubagentStore(),
    questionStore: useQuestionStore(), formStore: useFormStore(), permissionStore: usePermissionStore(), planViewStore: usePlanViewStore(),
    contextInjectionStore: useContextInjectionStore(), contextUsageStore: useContextUsageStore(), subscriptionUsageStore: useSubscriptionUsageStore(),
    elicitationStore: useElicitationStore(), btwStore: useBtwStore(),
  } as unknown as StoreContext;
  let state: unknown = {};
  return {
    stores,
    refs: { chatInputRef: { value: null } },
    bridge: { postMessage: vi.fn(), getState: <T,>() => state as T, setState: <T,>(next: T) => { state = next; } },
  } as unknown as HandlerContext;
}

// The whole registry, so a handler another domain registers under the same type would show here.
function buildRegistry(): HandlerRegistry {
  let built!: HandlerRegistry;
  const app = createApp({ setup() { built = createHandlerRegistry(); return () => null; } });
  app.use(i18n);
  app.mount(document.createElement('div'));
  app.unmount();
  return built;
}

function dispatch(msg: ExtensionToWebviewMessage): void {
  const handler = registry[msg.type] as ((m: ExtensionToWebviewMessage, c: HandlerContext) => void) | undefined;
  if (!handler) throw new Error(`no handler for ${msg.type}`);
  handler(msg, ctx);
}

beforeEach(() => {
  setActivePinia(createPinia());
  ctx = context();
  registry = buildRegistry();
});

describe('design handlers', () => {
  it('keeps the design chat state, the parent link and whether the chat opens designs in the browser, as core published them', () => {
    dispatch({ type: 'designState', design: DESIGN, link: null, openInBrowser: true });
    expect(useDesignStore().design).toEqual(DESIGN);
    expect(useDesignStore().openInBrowser).toBe(true);

    dispatch({ type: 'designState', design: null, link: LINK, openInBrowser: false });
    expect(useDesignStore().design).toBeNull();
    expect(useDesignStore().link).toEqual(LINK);
    expect(useDesignStore().openInBrowser).toBe(false);

    // A core that predates `chat.designOpenInBrowser` omits the field, which hides the buttons.
    dispatch({ type: 'designState', design: DESIGN, link: null, openInBrowser: true });
    dispatch({ type: 'designState', design: DESIGN, link: null });
    expect(useDesignStore().openInBrowser).toBe(false);
  });

  it('places a result card after the message the transcript ended with, and only a live one plays its entrance', () => {
    useStreamingStore().messages = [
      { id: 'u1', role: 'user', content: 'Design the contacts page first', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'Starting the design.', timestamp: 2 },
    ];
    const last = 'a1';

    dispatch({ type: 'designResult', entryId: 'e1', result: RESULT, replayed: true });
    dispatch({ type: 'designBrief', entryId: 'e2', brief: { briefId: 'b1', text: 'Design the contacts page', reopened: false } });

    expect(useDesignStore().cards).toEqual([
      { kind: 'result', entryId: 'e1', afterMessageId: last, afterTimestamp: 2, live: false, result: RESULT },
      { kind: 'brief', entryId: 'e2', afterMessageId: last, afterTimestamp: 2, live: true, brief: { briefId: 'b1', text: 'Design the contacts page', reopened: false } },
    ]);
  });

  it('keeps which result card core says awaits Continue', () => {
    dispatch({ type: 'designState', design: null, link: { ...LINK, awaitingContinue: 'e1' }, openPreview: true });
    expect(useDesignStore().link?.awaitingContinue).toBe('e1');
    expect(useDesignStore().openPreview).toBe(true);
  });

  it('anchors a card that comes before any message to the start, and replaces a card posted again for the same entry', () => {
    dispatch({ type: 'designResult', entryId: 'e1', result: RESULT });
    dispatch({ type: 'designResult', entryId: 'e1', result: { ...RESULT, title: 'Contacts again' }, replayed: true });

    expect(useDesignStore().cards).toHaveLength(1);
    expect(useDesignStore().cards[0]).toMatchObject({ afterMessageId: null, live: false, result: { title: 'Contacts again' } });
  });

  it('stores the folder listing core answered', () => {
    const store = useDesignStore();
    store.filesRequested(DESIGN.designId);
    expect(store.fileLists[DESIGN.designId]).toEqual({ files: [], loaded: false, refreshing: false, failed: false });

    dispatch({ type: 'designFiles', designId: DESIGN.designId, files: [{ path: 'design.md', bytes: 120 }] });
    expect(store.fileLists[DESIGN.designId]).toEqual({ files: [{ path: 'design.md', bytes: 120 }], loaded: true, refreshing: false, failed: false });

    // Opening the menu again keeps the list it holds while the new answer is out.
    store.filesRequested(DESIGN.designId);
    expect(store.fileLists[DESIGN.designId]).toEqual({ files: [{ path: 'design.md', bytes: 120 }], loaded: true, refreshing: true, failed: false });

    // A listing core could not make still answers, so the popover leaves its loading line.
    dispatch({ type: 'designFiles', designId: DESIGN.designId, files: [], failed: true });
    expect(store.fileLists[DESIGN.designId]).toEqual({ files: [], loaded: true, refreshing: false, failed: true });
  });

  it('holds an approval prompt once however often core posts it, until core closes it or the conversation clears', () => {
    const request = {
      type: 'requestDesignApproval', promptId: 'da-1', designId: DESIGN.designId, summary: 'Contacts', previousVersion: 1,
      changes: [{ kind: 'screenChanged', screen: 'S1' }], warnings: [], decisions: RESULT.decisions, screens: [{ id: 'S1', file: 'screens/S1.html' }],
      hasParent: false, owner: { kind: 'main' },
    } as const satisfies ExtensionToWebviewMessage;
    const { type: _type, owner: _owner, ...view } = request;

    dispatch(request);
    dispatch(request);
    expect(useDesignStore().approvalPrompts).toEqual([view]);

    dispatch({ type: 'designApprovalClosed', promptId: 'da-1' });
    expect(useDesignStore().approvalPrompts).toEqual([]);
    // A close for a prompt this view never held changes nothing.
    dispatch({ type: 'designApprovalClosed', promptId: 'da-1' });
    expect(useDesignStore().approvalPrompts).toEqual([]);

    dispatch(request);
    dispatch({ type: 'conversationCleared' });
    expect(useDesignStore().approvalPrompts).toEqual([]);
  });

  it('drops the cards when a replay starts, keeps the state its session published, and clears both for a new conversation', () => {
    dispatch({ type: 'designState', design: DESIGN, link: null, openInBrowser: false });
    dispatch({ type: 'designResult', entryId: 'e1', result: RESULT });

    dispatch({ type: 'sessionCleared', sessionId: 'design-1' });
    expect(useDesignStore().cards).toEqual([]);
    expect(useDesignStore().design).toEqual(DESIGN);

    dispatch({ type: 'conversationCleared' });
    expect(useDesignStore().design).toBeNull();
  });
});
