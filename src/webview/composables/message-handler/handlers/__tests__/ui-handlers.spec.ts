// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createUIHandlers } from '../ui-handlers';
import type { HandlerContext } from '../../types';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

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
