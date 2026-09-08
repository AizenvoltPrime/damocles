// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';

// `vue3-lottie` runs canvas setup at import time, which happy-dom does not provide.
vi.mock('vue3-lottie', () => ({ Vue3Lottie: { name: 'Vue3Lottie', render: () => null } }));

import StatusBar from '../StatusBar.vue';
import { i18n, applyLocale } from '@/i18n';

/**
 * The bar is the only place a parked run announces itself, so these cover the three things a user
 * notices: that it is up at all, that it does not look like a run that is working, and that a
 * screen reader hears the park. `awaitingUserAction` comes from the session store getter, which is
 * the single definition of the comparison.
 */

function mountBar(isProcessing: boolean, awaitingUserAction: boolean) {
  return mount(StatusBar, {
    props: { isProcessing, awaitingUserAction },
    global: { plugins: [i18n] },
  });
}

afterEach(() => applyLocale('en'));

describe('when the bar is on screen', () => {
  it('shows while the turn is running', () => {
    expect(mountBar(true, false).find('div').exists()).toBe(true);
  });

  it('stays up when a turn settles with a dialog still open', () => {
    // The publisher sends no message at turn end here, so the bar cannot depend on one.
    const bar = mountBar(false, true);

    expect(bar.text()).toContain('Waiting for your answer');
  });

  it('shows for a dialog opened with no turn in flight', () => {
    expect(mountBar(false, true).find('div').exists()).toBe(true);
  });

  it('hides once the run is idle and nothing is pending', () => {
    expect(mountBar(false, false).find('div').exists()).toBe(false);
  });
});

describe('telling a parked run from a working run', () => {
  it('tints the bar with the warning colour only when parked', () => {
    expect(mountBar(true, true).find('div').classes()).toContain('bg-warning/10');
    expect(mountBar(true, false).find('div').classes()).not.toContain('bg-warning/10');
  });

  it('swaps the spinner for a static icon', () => {
    expect(mountBar(true, false).findComponent({ name: 'Vue3Lottie' }).exists()).toBe(true);
    expect(mountBar(true, true).findComponent({ name: 'Vue3Lottie' }).exists()).toBe(false);
    expect(mountBar(true, true).find('svg').exists()).toBe(true);
  });

  it('drops the witty phrase, which reads as progress that is not happening', () => {
    const bar = mountBar(true, true);

    expect(bar.get('span.flex-1').text()).toBe('Waiting for your answer');
  });
});

describe('what a screen reader gets', () => {
  it('keeps the announcement region mounted while the run is working', () => {
    const region = mountBar(true, false).get('[role="status"]');

    expect(region.text()).toBe('');
  });

  it('keeps the announcement region mounted while the bar is hidden', () => {
    expect(mountBar(false, false).find('[role="status"]').exists()).toBe(true);
  });

  it('puts the parked label in that same region rather than mounting a new one', () => {
    const bar = mountBar(true, true);

    expect(bar.findAll('[role="status"]')).toHaveLength(1);
    expect(bar.get('[role="status"]').text()).toBe('Waiting for your answer');
  });

  it('hides the icon, which carries no accessible name', () => {
    const bar = mountBar(true, true);

    expect(bar.get('svg').element.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('hides the visible parked label, because the region already reads it out', () => {
    expect(mountBar(true, true).get('span.flex-1').attributes('aria-hidden')).toBe('true');
  });
});

describe('the parked label in Greek', () => {
  it('renders the translated string, not the key', () => {
    applyLocale('el');

    expect(mountBar(false, true).text()).toContain('Αναμονή για την απάντησή σας');
  });
});
