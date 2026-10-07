import type { ExtensionToWebviewMessage } from '../../../src/shared/types/messages.ts';
import type { Locator } from 'patchright';
import type { Stage } from './stage.ts';
import type { Accent } from './art.ts';

export interface Scene {
  id: string;
  /** The label on the scene's caption pills. */
  chapter: string;
  accent: Accent;
  /** What the extension posts after `ready`. */
  boot: ExtensionToWebviewMessage[];
  run(stage: Stage): Promise<void>;
}

/** The PermissionPrompt option by its value (`yes`, `yes-accept-all`, `no`, ...). */
export const permissionOption = (stage: Stage, value: string): Locator => stage.page.getByTestId(`permission-option-${value}`);

/** The composer's send button while a turn runs and the input is empty, when it stops the turn. */
export const stopButton = (stage: Stage): Locator => stage.page.getByTestId('composer-send').and(stage.page.getByRole('button', { name: 'Stop (Esc)' }));

/** A subagent or team card in the transcript, found by the description or title it shows. */
export const agentCard = (stage: Stage, text: string): Locator => stage.page.locator('div.cursor-pointer', { hasText: text }).first();

/** The close button of the topmost overlay. */
export const overlayClose = (stage: Stage): Locator => stage.page.locator('[data-testid="overlay-close"]:visible').last();
