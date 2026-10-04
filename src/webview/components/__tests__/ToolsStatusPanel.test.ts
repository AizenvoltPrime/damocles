// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolGroupStatus, ToolsSnapshot, ToolStatusInfo } from '@shared/types/tools';
import ToolsStatusPanel from '../ToolsStatusPanel.vue';
import ToolsStatusIndicator from '../ToolsStatusIndicator.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';

const GENERATE_IMAGE = { name: 'GenerateImage', label: 'Generate image', group: 'image', toggleable: true, enabled: false } as const;

const mounted: VueWrapper[] = [];

function mountPanel(snapshot: ToolsSnapshot): VueWrapper {
  const wrapper = mount(ToolsStatusPanel, {
    props: { snapshot },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

async function panel(image: ToolGroupStatus): Promise<void> {
  mountPanel({ groups: [image], tools: [GENERATE_IMAGE] });
  await nextTick();
}

function groupSwitch(): HTMLElement {
  const label = i18n.global.t('tools.groupSwitch', { group: i18n.global.t('tools.group.image') });
  const el = document.body.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`);
  if (!el) throw new Error('no image group switch carries its accessible name');
  return el;
}

/** The element the image group switch's aria-describedby names, if it exists. */
function unavailableNote(): HTMLElement | null {
  const id = groupSwitch().getAttribute('aria-describedby');
  return id ? document.getElementById(id) : null;
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

      expect(unavailableNote()?.textContent?.trim()).toBe(i18n.global.t(`tools.unavailable.${reason}`));
      expect(groupSwitch().hasAttribute('disabled')).toBe(true);
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

    expect(groupSwitch().hasAttribute('disabled')).toBe(false);
    expect(groupSwitch().hasAttribute('aria-describedby')).toBe(false);
  });
});

const tool = (name: string, group: ToolStatusInfo['group'], enabled: boolean, toggleable = true): ToolStatusInfo =>
  ({ name, label: name, description: `${name} blurb`, group, toggleable, enabled });

const SNAPSHOT: ToolsSnapshot = {
  groups: [
    { group: 'memory', enabled: true, available: true },
    { group: 'subagents', enabled: true, available: true },
    { group: 'core', enabled: true, available: true },
  ],
  tools: [
    tool('Remember', 'memory', true),
    tool('Recall', 'memory', false),
    tool('Forget', 'memory', false),
    tool('Agent', 'subagents', true),
    tool('Read', 'core', true, false),
    tool('Bash', 'core', true, false),
  ],
};

function byText(within: ReturnType<typeof group>, key: string) {
  const found = within.findAll('button').find((b) => b.text() === i18n.global.t(key));
  if (!found) throw new Error(`no ${key} button`);
  return found;
}

function group(wrapper: VueWrapper, name: string) {
  const found = wrapper.findAll('[data-testid="tools-group"]').find((g) => g.text().includes(i18n.global.t(`tools.group.${name}`)));
  if (!found) throw new Error(`no ${name} group`);
  return found;
}

describe('ToolsStatusPanel', () => {
  it('shows loading, not "no match", until the first toolStatus arrives', async () => {
    const wrapper = mountPanel({ groups: [], tools: [] });
    await nextTick();

    expect(wrapper.find('[data-testid="tools-loading"]').attributes('role')).toBe('status');
    expect(wrapper.text()).not.toContain(i18n.global.t('overlays.tools.noMatch', { query: '' }));

    await wrapper.setProps({ snapshot: SNAPSHOT });
    expect(wrapper.find('[data-testid="tools-loading"]').exists()).toBe(false);
  });

  it('filters tools by name, label or description, opening each matching group', async () => {
    const wrapper = mountPanel(SNAPSHOT);
    await wrapper.get('[data-testid="tools-filter"]').setValue('rec');

    expect(wrapper.findAll('[data-testid="tools-row"]').map((row) => row.text())).toEqual([expect.stringContaining('Recall')]);

    await wrapper.get('[data-testid="tools-filter"]').setValue('nothing-like-it');
    expect(wrapper.text()).toContain(i18n.global.t('overlays.tools.noMatch', { query: 'nothing-like-it' }));
  });

  it('Enable all and Disable all emit one toggle per tool that would change, skipping locked tools', async () => {
    const wrapper = mountPanel(SNAPSHOT);
    const memory = group(wrapper, 'memory');
    await memory.get('button[aria-expanded]').trigger('click');

    await byText(memory, 'overlays.tools.enableAll').trigger('click');
    expect(wrapper.emitted('toggle')).toEqual([['Recall', true], ['Forget', true]]);

    await byText(memory, 'overlays.tools.disableAll').trigger('click');
    expect(wrapper.emitted('toggle')!.slice(2)).toEqual([['Remember', false]]);

    expect(byText(group(wrapper, 'core'), 'overlays.tools.disableAll').attributes('disabled')).toBeDefined();
  });

  it('opens Subagents on open in an untrusted folder, so its trust notice shows', async () => {
    useSettingsStore().setProjectTrusted(false);
    const wrapper = mountPanel(SNAPSHOT);
    await nextTick();

    expect(group(wrapper, 'subagents').text()).toContain(i18n.global.t('tools.projectAgentsUntrusted'));
    expect(group(wrapper, 'memory').find('[data-testid="tools-row"]').exists()).toBe(false);
  });

  it('points aria-controls at the group body only while it exists', async () => {
    const wrapper = mountPanel(SNAPSHOT);
    const header = group(wrapper, 'memory').get('button[aria-expanded]');
    expect(header.attributes('aria-controls')).toBeUndefined();

    await header.trigger('click');
    const controls = header.attributes('aria-controls');
    expect(controls && document.getElementById(controls)?.textContent).toContain('Recall');
  });

  it('counts enabled tools by the same rule as the chat header indicator', () => {
    const wrapper = mountPanel(SNAPSHOT);
    const indicator = mount(ToolsStatusIndicator, { props: { snapshot: SNAPSHOT }, global: { plugins: [i18n] } });
    mounted.push(indicator);

    expect(wrapper.text()).toContain(i18n.global.t('overlays.tools.enabledCount', { n: 4, total: 6 }));
    expect(indicator.text()).toBe('4');
  });
});
