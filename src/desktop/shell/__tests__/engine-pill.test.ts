// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import EnginePill from '../components/EnginePill.vue';
import { shellI18n } from '../i18n';
import { fakeShellApi } from './fakes';

const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

function pill(state: 'halted' | 'restarting', name = 'prod-1') {
  const api = fakeShellApi();
  const wrapper = mount(EnginePill, {
    props: { api, halted: false, engines: [{ authority: 'ssh+h1', name, state }] },
    global: { plugins: [shellI18n], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return { api, button: wrapper.get('[data-testid="engine-host-pill"]') };
}

// The accessible name: aria-label when set, else the text.
const nameOf = (element: Element): string => element.getAttribute('aria-label') ?? element.textContent!.trim();

describe('a remote host\'s engine pill', () => {
  it('restarts that host\'s engine, its name holding its visible text', async () => {
    const { api, button } = pill('halted');
    expect(nameOf(button.element)).toContain(button.text());
    await button.trigger('click');
    expect(api.restartEngine).toHaveBeenCalledWith('ssh+h1');
  });

  it('keeps focus while restarting, says so in its text and name, and ignores a click', async () => {
    const { api, button } = pill('restarting');
    (button.element as HTMLElement).focus();
    expect(document.activeElement).toBe(button.element);
    expect(button.attributes('disabled')).toBeUndefined();
    expect(button.attributes('aria-disabled')).toBe('true');
    expect(button.text()).toBe('Restarting the engine on prod-1');
    expect(nameOf(button.element)).toBe(button.text());
    await button.trigger('click');
    expect(api.restartEngine).not.toHaveBeenCalled();
  });

  it('truncates a long host name, the full text in its title', () => {
    const name = 'x'.repeat(64);
    const { button } = pill('halted', name);
    expect(button.get('.truncate').text()).toBe(`Engine stopped on ${name}`);
    expect(button.attributes('title')).toContain(name);
  });
});
