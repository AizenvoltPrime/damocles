// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import type { ToolCall } from '@shared/types/session';
import {
  DESIGN_CHAT_TOOLS,
  TOOL_DECLARE_TWEAKS,
  TOOL_DESIGN_CHECK,
  TOOL_DESIGN_SCREENSHOT,
  TOOL_EXTRACT_TOKENS,
  TOOL_FINISH_DESIGN,
  TOOL_IMPORT_ASSET,
  TOOL_INVENTORY,
  TOOL_LOAD_DESIGN_SKILL,
  TOOL_MAP_REFERENCE,
  TOOL_OPEN_PREVIEW,
  TOOL_RECORD_DECISION,
  TOOL_REMOVE_DESIGN_FILE,
  TOOL_START_DESIGN,
} from '@shared/tool-names';
import { i18n } from '@/i18n';
import ToolCallRouter from '../ToolCallRouter.vue';

vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (_m: WebviewToExtensionMessage) => undefined, onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const mounted: VueWrapper[] = [];
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

function route(name: string): VueWrapper {
  const toolCall: ToolCall = { id: `call-${name}`, name, input: {}, status: 'running' };
  const wrapper = mount(ToolCallRouter, {
    props: { toolCall, toolUseId: toolCall.id, toolName: name, message: { id: 'a1', role: 'assistant', content: '', timestamp: 1 } },
    global: { plugins: [i18n] },
  });
  mounted.push(wrapper);
  return wrapper;
}

describe('the tool card router for design tools', () => {
  it('routes StartDesign and FinishDesign to their own cards', () => {
    expect(route(TOOL_START_DESIGN).find('[data-testid="start-design-card"]').exists()).toBe(true);
    expect(route(TOOL_FINISH_DESIGN).find('[data-testid="finish-design-card"]').exists()).toBe(true);
  });

  it('routes each design chat tool, by its exact name, to the design tool card', () => {
    const names = [TOOL_INVENTORY, TOOL_EXTRACT_TOKENS, TOOL_IMPORT_ASSET, TOOL_DESIGN_CHECK, TOOL_RECORD_DECISION, TOOL_DESIGN_SCREENSHOT, TOOL_LOAD_DESIGN_SKILL, TOOL_DECLARE_TWEAKS, TOOL_MAP_REFERENCE, TOOL_REMOVE_DESIGN_FILE, TOOL_OPEN_PREVIEW];
    expect([...DESIGN_CHAT_TOOLS].sort()).toEqual([...names].sort());
    for (const name of names) {
      const card = route(name).find('[data-testid="design-tool-card"]');
      expect(card.exists(), name).toBe(true);
      expect(card.attributes('data-tool')).toBe(name);
    }
  });

  it('routes a name that only resembles a design tool to the generic card', () => {
    const wrapper = route('inventory');
    expect(wrapper.find('[data-testid="design-tool-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="tool-card"]').exists()).toBe(true);
  });
});
