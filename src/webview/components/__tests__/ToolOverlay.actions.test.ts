// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import ToolOverlay from '../ToolOverlay.vue';
import { i18n } from '@/i18n';

const posted = vi.hoisted((): WebviewToExtensionMessage[] => []);
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m), onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const mounted: VueWrapper[] = [];

function overlay(tool: ToolCall): VueWrapper {
  const wrapper = mount(ToolOverlay, {
    props: { tool },
    global: { plugins: [i18n], stubs: { LiveOutputPane: true, MarkdownRenderer: true, CodeBlock: true, ToolResultImages: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

const headerButton = (wrapper: VueWrapper, label: string) => wrapper.findAll('header button').find((b) => b.text() === label);

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
});

describe('ToolOverlay actions', () => {
  it('Open file opens the file a Read named at the first line it read', async () => {
    const wrapper = overlay({
      id: 't-1',
      name: 'Read',
      input: { file_path: 'src/app.ts' },
      status: 'completed',
      result: 'export {}',
      metadata: { numLines: 10, startLine: 41, totalLines: 200 },
    });

    await headerButton(wrapper, i18n.global.t('overlays.tool.openFile'))!.trigger('click');

    expect(posted).toEqual([{ type: 'openFile', filePath: 'src/app.ts', line: 41 }]);
  });

  it('marks the output of a stopped call neither successful nor failed', () => {
    const wrapper = overlay({ id: 't-3', name: 'Bash', input: { command: 'sleep 20' }, status: 'cancelled', result: 'Command aborted', isError: true });
    const response = wrapper.findAll('button').find((b) => b.text().startsWith(i18n.global.t('toolOverlay.response')));

    expect(response?.find('svg.lucide-ban').exists()).toBe(true);
    expect(response?.find('svg.lucide-circle-check').exists()).toBe(false);
  });

  it('offers no Open file for a tool that names no file', () => {
    const wrapper = overlay({ id: 't-2', name: 'Bash', input: { command: 'ls' }, status: 'completed', result: 'a' });

    expect(headerButton(wrapper, i18n.global.t('overlays.tool.openFile'))).toBeUndefined();
  });

  it('copies the shell command with one click', async () => {
    const writeText = vi.fn(async () => {});
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard);
    const wrapper = overlay({ id: 't-3', name: 'PowerShell', input: { command: 'Get-ChildItem -Force' }, status: 'completed', result: 'a' });

    await wrapper.get('[data-testid="tool-overlay-copy-command"]').trigger('click');

    expect(writeText).toHaveBeenCalledWith('Get-ChildItem -Force');
  });

  it('names the input and output bodies in aria-controls only while they are shown', async () => {
    const wrapper = overlay({ id: 't-4', name: 'Bash', input: { command: 'ls' }, status: 'completed', result: 'a' });
    const toggles = wrapper.findAll('button[aria-expanded]');
    expect(toggles).toHaveLength(2);

    for (const toggle of toggles) {
      const controls = toggle.attributes('aria-controls');
      expect(controls && document.getElementById(controls)).toBeTruthy();
      await toggle.trigger('click');
      expect(toggle.attributes('aria-controls')).toBeUndefined();
    }
  });
});

describe('ToolOverlay status', () => {
  it('names a call that waits for approval and offers no Stop', () => {
    const wrapper = overlay({ id: 't-5', name: 'PowerShell', input: { command: 'npm install' }, status: 'awaiting_approval' });

    expect(wrapper.get('header').text()).toContain(i18n.global.t('toolCall.awaitingApproval'));
    expect(wrapper.find(`button[aria-label="${i18n.global.t('toolCall.stopWithNote')}"]`).exists()).toBe(false);
  });
});
