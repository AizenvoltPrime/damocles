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

/** The PermissionPrompt option whose label is `label` ("Yes", "Yes, accept all edits", ...). */
export const permissionOption = (stage: Stage, label: string): Locator =>
  stage.page
    .locator('[role="region"][aria-label="Permission request"] [role="option"]')
    .filter({ hasText: new RegExp(`^\\d?\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });

/** The composer's Stop button, shown in place of Send while a turn runs; it has no accessible name. */
export const stopButton = (stage: Stage): Locator => stage.page.locator('button.bg-destructive').last();

/** A subagent or team card in the transcript, found by the description or title it shows. */
export const agentCard = (stage: Stage, text: string): Locator => stage.page.locator('div.cursor-pointer', { hasText: text }).first();

/** The back arrow of the topmost overlay. */
export const overlayClose = (stage: Stage): Locator => stage.page.locator('[role="dialog"]').last().getByRole('button', { name: 'Close' }).first();
