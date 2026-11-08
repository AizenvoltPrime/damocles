import type { Input, WebContents } from 'electron';
import { FOCUS_NEXT_PART_ACCELERATOR, FOCUS_PREVIOUS_PART_ACCELERATOR } from './commands';

export type PartStep = 1 | -1;

/** The part a key pressed in a page view moves focus to: Focus Next Part's or Focus Previous Part's accelerator, else none. */
export function partStepOf(input: Pick<Input, 'type' | 'key' | 'shift' | 'control' | 'alt' | 'meta'>): PartStep | undefined {
  if (input.type !== 'keyDown' || input.control || input.alt || input.meta) return undefined;
  const pressed = input.shift ? `Shift+${input.key}` : input.key;
  return pressed === FOCUS_NEXT_PART_ACCELERATOR ? 1 : pressed === FOCUS_PREVIOUS_PART_ACCELERATOR ? -1 : undefined;
}

/**
 * The way out of a page view (an HTML preview, a design preview, a browser page): its page never sees Focus Next or Previous
 * Part's key, so no page can keep keyboard focus, and focusPart moves on from the editor part the view belongs to.
 */
export function leavePageOnPartKeys(contents: Pick<WebContents, 'on'>, focusPart: (step: PartStep) => void): void {
  contents.on('before-input-event', (event, input) => {
    const step = partStepOf(input);
    if (step === undefined) return;
    // also keeps the menu's own accelerator from running the step a second time
    event.preventDefault();
    focusPart(step);
  });
}
