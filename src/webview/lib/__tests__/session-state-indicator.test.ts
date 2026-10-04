import { describe, it, expect } from 'vitest';
import { sessionStateTreatment } from '../session-state-indicator';

/**
 * A run parked on a permission dialog used to look exactly like a run that was working, so these
 * assertions pin the difference in the data rather than leaving it to whoever last looked at the row.
 */

const running = sessionStateTreatment('running');
const parked = sessionStateTreatment('requires_action');
const idle = sessionStateTreatment('idle');

describe('the parked run against the working run', () => {
  it('moves differently, so motion alone separates the two', () => {
    expect(parked.iconClass).toContain('d-pulse');
    expect(running.iconClass).toContain('d-spin');
    expect(running.iconClass).not.toContain('d-pulse');
  });

  it('colours the parked mark and label with the warning token only', () => {
    expect(parked.iconClass).toContain('--d-warning');
    expect(parked.labelClass).toContain('--d-warning');
    expect(running.iconClass).not.toContain('warning');
    expect(running.labelClass).not.toContain('warning');
  });
});

describe('the idle treatment', () => {
  it('carries no warning colour', () => {
    expect(idle.labelClass).not.toContain('warning');
  });
});
