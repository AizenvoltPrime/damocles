// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { createUIHandlers } from '../ui-handlers';
import type { HandlerContext } from '../../types';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { i18n } from '@/i18n';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

const toastMock = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('vue-sonner', () => ({ toast: toastMock }));

type StatusUpdate = Extract<ExtensionToWebviewMessage, { type: 'statusUpdate' }>;

function context(): HandlerContext {
  return { stores: { uiStore: useUIStore(), settingsStore: useSettingsStore() } } as unknown as HandlerContext;
}

function dispatch(msg: StatusUpdate, ctx: HandlerContext): void {
  createUIHandlers().statusUpdate!(msg, ctx);
}

describe('statusUpdate retry status', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('holds the attempt while pi waits to retry, and a ready status clears it', () => {
    const ctx = context();
    const ui = useUIStore();

    dispatch({ type: 'statusUpdate', status: 'retrying', attempt: 2, maxAttempts: 3 }, ctx);
    expect(ui.retryStatus).toEqual({ attempt: 2, maxAttempts: 3 });
    expect(ui.isCompacting).toBe(false);

    dispatch({ type: 'statusUpdate', status: 'ready' }, ctx);
    expect(ui.retryStatus).toBeNull();
  });

  it('a turn that stops processing clears a retry status that no ready status ended', () => {
    const ctx = context();
    const ui = useUIStore();
    ui.setProcessing(true);
    dispatch({ type: 'statusUpdate', status: 'retrying', attempt: 1, maxAttempts: 3 }, ctx);

    ui.setProcessing(false);
    expect(ui.retryStatus).toBeNull();
  });
});

describe('promptReturned for a send core refused before it started', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    toastMock.info.mockClear();
  });

  const TEXTS = {
    en: {
      sendInProgress: 'This chat started working on something else before your message arrived, so your message is back in the input.',
      queueRunEnded: 'The agent finished before your message could join its turn, so your message is back in the input.',
      queueBudgetStopped: 'The budget limit stopped this turn before your message could join it, so your message is back in the input.',
      queueNoRuntime: "This chat's agent is not running, so your message is back in the input. Send it again to start it.",
    },
    el: {
      sendInProgress: 'Αυτή η συνομιλία άρχισε να εργάζεται σε κάτι άλλο πριν φτάσει το μήνυμά σας, οπότε το μήνυμά σας επέστρεψε στο πεδίο εισαγωγής.',
      queueRunEnded: 'Ο πράκτορας ολοκλήρωσε πριν το μήνυμά σας προλάβει να μπει στον γύρο του, οπότε το μήνυμά σας επέστρεψε στο πεδίο εισαγωγής.',
      queueBudgetStopped: 'Το όριο προϋπολογισμού σταμάτησε αυτόν τον γύρο πριν το μήνυμά σας προλάβει να μπει σε αυτόν, οπότε το μήνυμά σας επέστρεψε στο πεδίο εισαγωγής.',
      queueNoRuntime: 'Ο πράκτορας αυτής της συνομιλίας δεν εκτελείται, οπότε το μήνυμά σας επέστρεψε στο πεδίο εισαγωγής. Στείλτε το ξανά για να ξεκινήσει.',
    },
  } as const;

  it.each(['en', 'el'] as const)('each new reason toasts its %s text', (locale) => {
    const before = i18n.global.locale.value;
    i18n.global.locale.value = locale;
    try {
      for (const reason of ['sendInProgress', 'queueRunEnded', 'queueBudgetStopped', 'queueNoRuntime'] as const) {
        toastMock.info.mockClear();
        const restoreQueued = vi.fn();
        const ctx = { stores: { uiStore: useUIStore(), streamingStore: useStreamingStore() }, refs: { chatInputRef: ref({ restoreQueued }) } } as unknown as HandlerContext;
        createUIHandlers().promptReturned!({ type: 'promptReturned', content: [{ type: 'text', text: 'go' }], reason }, ctx);
        expect(restoreQueued).toHaveBeenCalledWith([{ type: 'text', text: 'go' }]);
        expect(toastMock.info).toHaveBeenCalledWith(TEXTS[locale][reason]);
      }
    } finally {
      i18n.global.locale.value = before;
    }
  });
});
