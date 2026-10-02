// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolGroupStatus, ToolsSnapshot } from '@shared/types/tools';
import ToolsStatusPanel from '../ToolsStatusPanel.vue';
import { i18n } from '@/i18n';

const GENERATE_IMAGE = { name: 'GenerateImage', label: 'Generate image', group: 'image', toggleable: true, enabled: false } as const;

const mounted: VueWrapper[] = [];

async function panel(image: ToolGroupStatus): Promise<void> {
  const snapshot: ToolsSnapshot = { groups: [image], tools: [GENERATE_IMAGE] };
  mounted.push(mount(ToolsStatusPanel, {
    props: { snapshot, visible: true },
    global: { plugins: [i18n] },
    attachTo: document.body,
  }));
  // Reka mounts the dialog's portalled content on the tick after mount.
  await nextTick();
}

function groupSwitch(): HTMLElement {
  const label = i18n.global.t('tools.groupSwitch', { group: i18n.global.t('tools.group.image') });
  const el = document.body.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`);
  if (!el) throw new Error('no image group switch carries its accessible name');
  return el;
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('ToolsStatusPanel image group', () => {
  it('labels the group', async () => {
    await panel({ group: 'image', enabled: false, available: true });
    expect(document.body.textContent).toContain(i18n.global.t('tools.group.image'));
  });

  it.each(['noModel', 'unknownModel', 'noOpenRouterKey'] as const)(
    'shows the %s reason and disables turning the master switch on, which the reason describes',
    async (reason) => {
      await panel({ group: 'image', enabled: false, available: false, unavailableReason: reason });
      const text = i18n.global.t(`tools.unavailable.${reason}`);
      const note = document.body.querySelector<HTMLElement>('#tools-unavailable-image');

      expect(note?.textContent?.trim()).toBe(text);
      expect(groupSwitch().hasAttribute('disabled')).toBe(true);
      expect(groupSwitch().getAttribute('aria-describedby')).toBe('tools-unavailable-image');
    },
  );

  it('lets an enabled group that became unavailable be turned off', async () => {
    await panel({ group: 'image', enabled: true, available: false, unavailableReason: 'noOpenRouterKey' });

    expect(groupSwitch().hasAttribute('disabled')).toBe(false);
    groupSwitch().click();
    await nextTick();
    expect(mounted[0]?.emitted('toggleGroup')).toEqual([['image', false]]);
  });

  it('shows no reason and enables the switch when the group is available', async () => {
    await panel({ group: 'image', enabled: false, available: true });

    expect(document.body.querySelector('#tools-unavailable-image')).toBeNull();
    expect(groupSwitch().hasAttribute('disabled')).toBe(false);
    expect(groupSwitch().hasAttribute('aria-describedby')).toBe(false);
  });
});
