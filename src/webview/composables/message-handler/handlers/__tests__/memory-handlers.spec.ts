import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { i18n } from '@/i18n';
import { createMemoryHandlers } from '../memory-handlers';
import { useMemoryStore } from '@/stores/useMemoryStore';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import { useUIStore } from '@/stores/useUIStore';
import type { HandlerContext } from '../../types';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { MemoryEntry } from '@shared/types/memory';

const toasts = vi.hoisted((): string[] => []);
vi.mock('vue-sonner', () => {
  const record = (text: string) => void toasts.push(text);
  return { toast: Object.assign(record, { success: record, error: record, info: record }) };
});

function deliver(msg: ExtensionToWebviewMessage): void {
  const ctx = {
    stores: { memoryStore: useMemoryStore(), contextInjectionStore: useContextInjectionStore(), uiStore: useUIStore() },
  } as unknown as HandlerContext;
  const handler = createMemoryHandlers()[msg.type] as ((m: ExtensionToWebviewMessage, c: HandlerContext) => void) | undefined;
  handler!(msg, ctx);
}

const memory: MemoryEntry = { id: 'm1', tier: 'global', kind: 'fact', content: 'x', sessionId: null, workspace: null, createdAt: 1, updatedAt: 1, tags: [] };

beforeEach(() => {
  setActivePinia(createPinia());
  toasts.length = 0;
});
afterEach(() => {
  i18n.global.locale.value = 'en';
});

describe('memory toasts', () => {
  it('pluralizes forget and restore counts', () => {
    deliver({ type: 'memoryForgotten', id: 'm1', count: 1 });
    deliver({ type: 'memoryForgotten', id: 'm1', count: 3 });
    deliver({ type: 'memoryUnforgotten', id: 'm1', count: 2 });
    expect(toasts).toEqual(['Forgot 1 memory', 'Forgot 3 memories', 'Restored 2 memories']);
  });

  it('speaks the UI language', () => {
    i18n.global.locale.value = 'el';
    deliver({ type: 'memoryCreated', memory });
    deliver({ type: 'memoryPinned', id: 'm1' });
    deliver({ type: 'memoryForgotten', id: 'm1', count: 2 });
    expect(toasts).toEqual(['Η καθολική μνήμη αποθηκεύτηκε', 'Η μνήμη καρφιτσώθηκε', 'Ξεχάστηκαν 2 μνήμες']);
  });

  it('opens the memory panel without asking for the list, which the panel requests itself', () => {
    const postMessage = vi.fn();
    const ctx = { stores: { uiStore: useUIStore() }, vscode: { postMessage } } as unknown as HandlerContext;
    createMemoryHandlers().openMemoryPanel!({ type: 'openMemoryPanel' }, ctx);
    expect(useUIStore().showMemoryPanel).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
