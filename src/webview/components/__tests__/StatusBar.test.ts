// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';

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
    expect(mountBar(true, false).find('[data-testid="status-row"]').exists()).toBe(true);
  });

  it('stays up when a turn settles with a dialog still open', () => {
    // The publisher sends no message at turn end here, so the bar cannot depend on one.
    const bar = mountBar(false, true);

    expect(bar.text()).toContain('Waiting for your answer');
  });

  it('shows for a dialog opened with no turn in flight', () => {
    expect(mountBar(false, true).find('[data-testid="status-row"]').exists()).toBe(true);
  });

  it('hides once the run is idle and nothing is pending', () => {
    expect(mountBar(false, false).find('[data-testid="status-row"]').exists()).toBe(false);
  });
});

describe('telling a parked run from a working run', () => {
  it('colours the row with the warning token only when parked', () => {
    expect(mountBar(true, true).get('[data-testid="status-label"]').classes()).toContain('text-(--d-warning)');
    expect(mountBar(true, false).get('[data-testid="status-label"]').classes()).not.toContain('text-(--d-warning)');
  });

  it('swaps the spinner for a pulsing dot', () => {
    expect(mountBar(true, false).find('svg.lucide-loader-circle').exists()).toBe(true);
    expect(mountBar(true, true).find('svg').exists()).toBe(false);
    expect(mountBar(true, true).find('span.rounded-full').classes()).toContain('animate-[d-pulse_1.2s_infinite]');
  });

  it('drops the witty phrase, which reads as progress that is not happening', () => {
    const bar = mountBar(true, true);

    expect(bar.get('[data-testid="status-label"]').text()).toBe('Waiting for your answer');
    expect(bar.text()).not.toContain('Esc to interrupt');
  });

  it('offers Esc to interrupt while working, with the phrase drawn by the transform shimmer', () => {
    const bar = mountBar(true, false);

    expect(bar.text()).toContain('Esc to interrupt');
    expect(bar.get('[data-testid="status-label"]').classes()).toContain('d-glint');
    expect(bar.get('.d-glint-window').attributes('aria-hidden')).toBe('true');
  });

  it('names the running tool instead of a phrase', () => {
    const bar = mount(StatusBar, {
      props: { isProcessing: true, awaitingUserAction: false, currentToolName: 'Bash' },
      global: { plugins: [i18n] },
    });

    expect(bar.get('[data-testid="status-label"]').text()).toContain('Running Bash');
  });

  it('counts the elapsed time from when the row appears', async () => {
    vi.useFakeTimers();
    try {
      const bar = mountBar(true, false);
      expect(bar.get('[data-testid="status-elapsed"]').text()).toBe('0s');
      await vi.advanceTimersByTimeAsync(65_000);
      expect(bar.get('[data-testid="status-elapsed"]').text()).toBe('1:05');
    } finally {
      vi.useRealTimers();
    }
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

  it('hides the marks, which carry no accessible name', () => {
    expect(mountBar(true, false).get('svg').attributes('aria-hidden')).toBe('true');
    expect(mountBar(true, true).get('span.rounded-full').attributes('aria-hidden')).toBe('true');
  });

  it('hides the visible parked label, because the region already reads it out', () => {
    expect(mountBar(true, true).get('[data-testid="status-label"]').attributes('aria-hidden')).toBe('true');
  });
});

describe('the parked label in Greek', () => {
  it('renders the translated string, not the key', () => {
    applyLocale('el');

    expect(mountBar(false, true).text()).toContain('Αναμονή για την απάντησή σας');
  });
});
