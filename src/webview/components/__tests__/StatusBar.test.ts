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

  // A page that loads again mid-turn learns the turn's start from core's snapshot.
  it('counts from the turn start it is given, and keeps counting from it', async () => {
    vi.useFakeTimers();
    try {
      const bar = mount(StatusBar, {
        props: { isProcessing: true, awaitingUserAction: false, turnStartedAt: Date.now() - 30_000 },
        global: { plugins: [i18n] },
      });
      expect(bar.get('[data-testid="status-elapsed"]').text()).toBe('30s');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(bar.get('[data-testid="status-elapsed"]').text()).toBe('32s');
    } finally {
      vi.useRealTimers();
    }
  });

  // A rejoining page can show the bar for a prompt or a wind-down before core's snapshot says how long the turn has run.
  it('moves the clock to a turn start that arrives while the bar is up, and keeps it when the start is cleared', async () => {
    vi.useFakeTimers();
    try {
      const bar = mount(StatusBar, {
        props: { isProcessing: false, awaitingUserAction: true },
        global: { plugins: [i18n] },
      });
      await bar.setProps({ awaitingUserAction: false, isProcessing: true });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(bar.get('[data-testid="status-elapsed"]').text()).toBe('2s');

      await bar.setProps({ turnStartedAt: Date.now() - 40_000 });
      expect(bar.get('[data-testid="status-elapsed"]').text()).toBe('40s');

      await bar.setProps({ turnStartedAt: undefined, isProcessing: false, awaitingUserAction: true });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(bar.text()).toContain('Waiting for your answer');
      await bar.setProps({ awaitingUserAction: false, isProcessing: true });
      expect(bar.get('[data-testid="status-elapsed"]').text()).toBe('41s');
    } finally {
      vi.useRealTimers();
    }
  });

  // Core measures the turn on its own clock, which can step back.
  it('never counts below zero', async () => {
    vi.useFakeTimers();
    try {
      const bar = mount(StatusBar, {
        props: { isProcessing: true, awaitingUserAction: false, turnStartedAt: Date.now() + 5_000 },
        global: { plugins: [i18n] },
      });
      expect(bar.get('[data-testid="status-elapsed"]').text()).toBe('0s');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(bar.get('[data-testid="status-elapsed"]').text()).toBe('0s');
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

describe("a stopped run's wind-down, as core published it", () => {
  const LINE = "Stopping: waiting for pi's agent_settled handlers to return. pi gives them no abort signal. pi extensions with such a handler: C:\\x\\held.js.";

  function mountWindDown(isProcessing: boolean, windDown: string | undefined) {
    return mount(StatusBar, {
      props: { isProcessing, awaitingUserAction: false, windDown },
      global: { plugins: [i18n] },
    });
  }

  it('puts the bar up with the line after the Stop, though the turn shows stopped', () => {
    const bar = mountWindDown(false, LINE);

    expect(bar.find('[data-testid="status-row"]').exists()).toBe(true);
    expect(bar.get('[data-testid="status-wind-down"]').text()).toBe(LINE);
    expect(bar.get('[data-testid="status-wind-down"]').attributes('title')).toBe(LINE);
    // Esc has no send to take back.
    expect(bar.text()).not.toContain('Esc to interrupt');
  });

  it('says why a send that waits behind it has not started, in place of the phrase, and keeps Esc', () => {
    const bar = mountWindDown(true, LINE);

    expect(bar.get('[data-testid="status-wind-down"]').text()).toBe(LINE);
    expect(bar.find('.d-glint').exists()).toBe(false);
    expect(bar.text()).toContain('Esc to interrupt');
  });

  it('takes the line down once it is cleared', async () => {
    const bar = mountWindDown(false, LINE);

    await bar.setProps({ windDown: undefined });

    expect(bar.find('[data-testid="status-wind-down"]').exists()).toBe(false);
    expect(bar.find('[data-testid="status-row"]').exists()).toBe(false);
  });

  it('announces the line in the one status region', () => {
    const bar = mountWindDown(false, LINE);

    expect(bar.findAll('[role="status"]')).toHaveLength(1);
    expect(bar.get('[role="status"]').text()).toBe(LINE);
    expect(bar.get('[data-testid="status-wind-down"]').attributes('aria-hidden')).toBe('true');
  });

  it('gives way to a prompt waiting on the user', () => {
    const bar = mount(StatusBar, {
      props: { isProcessing: false, awaitingUserAction: true, windDown: LINE },
      global: { plugins: [i18n] },
    });

    expect(bar.find('[data-testid="status-wind-down"]').exists()).toBe(false);
    expect(bar.get('[data-testid="status-label"]').text()).toBe('Waiting for your answer');
  });
});

describe('the parked label in Greek', () => {
  it('renders the translated string, not the key', () => {
    applyLocale('el');

    expect(mountBar(false, true).text()).toContain('Αναμονή για την απάντησή σας');
  });
});
