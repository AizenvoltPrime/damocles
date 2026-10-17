// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { Component } from 'vue';
import CommitAttachmentChip from '../CommitAttachmentChip.vue';
import TerminalAttachmentChip from '../TerminalAttachmentChip.vue';
import { i18n } from '@/i18n';
import { HOVER_OPEN_MS } from '@/composables/useHoverPreview';
import type { CommitAttachmentInfo } from '@shared/types/chat-attachment';
import type { TerminalAttachmentInfo } from '@shared/types/terminal-attachment';

/** A hover opens an attachment's preview without focus; a click on the chip makes it a popover that holds focus and stays. */

const commit: CommitAttachmentInfo = {
  id: 'c1', kind: 'commit', hash: '1a2b3c4d5e6f'.padEnd(40, '0'), subject: 'Rework the exports', author: 'Ada', authorDate: Date.UTC(2026, 4, 1, 10, 30),
  lineCount: 2, omittedLines: 0, preview: 'commit 1a2b3c4\nexports',
};
const terminal: TerminalAttachmentInfo = { id: 't1', kind: 'terminal', source: 'selection', commandLine: null, exitCode: null, terminalTitle: 'bash', lineCount: 1, omittedLines: 0, preview: 'ok' };

const CHIPS: Array<[string, Component, Record<string, unknown>]> = [
  ['commit', CommitAttachmentChip, { attachment: commit }],
  ['terminal', TerminalAttachmentChip, { attachment: terminal }],
];

const mounted: VueWrapper[] = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
});
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
});

describe.each(CHIPS)('the %s chip\'s preview', (kind, component, props) => {
  function render(): { trigger: HTMLElement; preview: () => HTMLElement | null } {
    const wrapper = mount(component, { props, global: { plugins: [i18n] }, attachTo: document.body });
    mounted.push(wrapper);
    return {
      trigger: wrapper.get(`[data-testid="${kind}-attachment-preview-button"]`).element as HTMLElement,
      preview: () => document.querySelector<HTMLElement>(`[data-testid="${kind}-attachment-preview"]`),
    };
  }

  function press(trigger: HTMLElement): void {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    trigger.focus();
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  async function hoverOpen(trigger: HTMLElement): Promise<void> {
    trigger.dispatchEvent(new PointerEvent('pointerenter'));
    await wait(HOVER_OPEN_MS + 50);
  }

  it('opens on hover without taking focus', async () => {
    const { trigger, preview } = render();

    await hoverOpen(trigger);

    expect(preview()).not.toBeNull();
    expect(preview()!.contains(document.activeElement)).toBe(false);
  });

  it('stays open and takes focus when the chip is clicked while the hover holds it open', async () => {
    const { trigger, preview } = render();
    await hoverOpen(trigger);

    press(trigger);
    await wait(20);

    expect(preview()).not.toBeNull();
    expect(preview()!.contains(document.activeElement)).toBe(true);
  });

  it('then closes on Escape, and on a second click once open from a click', async () => {
    const { trigger, preview } = render();
    await hoverOpen(trigger);
    press(trigger);
    await wait(20);

    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(20);
    expect(preview()).toBeNull();

    press(trigger);
    await wait(20);
    expect(preview()).not.toBeNull();
    press(trigger);
    await wait(20);
    expect(preview()).toBeNull();
  });

  it('stays open after the pointer leaves, once a click made it a popover', async () => {
    const { trigger, preview } = render();
    await hoverOpen(trigger);
    press(trigger);
    await wait(20);

    trigger.dispatchEvent(new PointerEvent('pointerleave'));
    await wait(300);

    expect(preview()).not.toBeNull();
  });
});
