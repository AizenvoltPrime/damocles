import { describe, it, expect } from 'vitest';
import { sessionStateTreatment } from '../session-state-indicator';

/**
 * A run parked on a permission dialog used to look exactly like a run that was working, so these
 * assertions pin the difference in the data rather than leaving it to whoever last looked at the bar.
 * The module names an icon and never imports one, so nothing here needs a component stub.
 */

const running = sessionStateTreatment('running');
const parked = sessionStateTreatment('requires_action');
const idle = sessionStateTreatment('idle');

describe('the parked run against the working run', () => {
  it('names a different icon', () => {
    expect(running.icon).toBe('spinner');
    expect(parked.icon).toBe('exclamation');
  });

  it('colours the parked icon and gives the spinner no colour it cannot use', () => {
    expect(parked.iconClass).toContain('text-warning');
    // The spinner reads its colours from the animation JSON, so a text colour on its box would be a lie.
    expect(running.iconClass).toBe('');
  });

  it('animates the parked icon on its own, so motion alone separates the two', () => {
    expect(parked.iconClass).toContain('motion-safe:animate-pulse');
    expect(running.iconClass).not.toContain('animate-pulse');
  });

  it('tints the whole bar differently', () => {
    expect(parked.barClass).toContain('bg-warning/10');
    expect(parked.barClass).toContain('border-warning/40');
    expect(running.barClass).not.toContain('warning');
  });

  it('colours the label to match the icon', () => {
    expect(parked.labelClass).toContain('text-warning');
    expect(running.labelClass).not.toContain('text-warning');
  });

  it('differs on colour and on shape at once, not on colour alone', () => {
    const colourOnly = parked.icon === running.icon && parked.iconClass !== running.iconClass;

    expect(colourOnly).toBe(false);
  });
});

describe('the idle treatment', () => {
  it('draws no icon, because the bar is not shown when nothing is happening', () => {
    expect(idle.icon).toBeNull();
  });

  it('carries no warning tint', () => {
    expect(idle.barClass).not.toContain('warning');
    expect(idle.labelClass).not.toContain('warning');
  });
});

describe('every state', () => {
  it.each(['idle', 'running', 'requires_action'] as const)('returns a complete treatment for %s', (state) => {
    const treatment = sessionStateTreatment(state);

    expect(typeof treatment.iconClass).toBe('string');
    expect(typeof treatment.labelClass).toBe('string');
    expect(typeof treatment.barClass).toBe('string');
    expect(typeof treatment.iconSize).toBe('number');
  });
});
