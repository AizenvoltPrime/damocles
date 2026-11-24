import { ref } from 'vue';
import { defineStore } from 'pinia';
import { applyThemeChangeUpdate, type ThemeCardUpdate } from '@shared/themes/agent';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { dropInstallThumbs, takeInstallThumbs } from '@/utils/install-thumbs';

/** A raised theme preview prompt, as `requestThemeChange` carries it and `themeChangeUpdated` changes it. */
export type ThemeChangePromptView = Omit<Extract<ExtensionToWebviewMessage, { type: 'requestThemeChange' }>, 'type'>;
// Omit per member, so the screenshot prompt stays a union a card can narrow.
type WithoutType<T> = T extends unknown ? Omit<T, 'type'> : never;
/** A raised screenshot consent prompt, as `requestThemeScreenshot` carries it: a capture the card shows, or a draft. */
export type ThemeScreenshotPromptView = WithoutType<Extract<ExtensionToWebviewMessage, { type: 'requestThemeScreenshot' }>>;
/**
 * A raised install prompt, as `requestThemeInstall` carries it and `themeInstallUpdated` replaces its preview, without the
 * wallpaper thumbnails, which the page's image cache holds (utils/install-thumbs.ts); `progress` holds each running flash
 * check's `themeInstallProgress` by the wallpaper's sha256.
 */
export type ThemeInstallPromptView = Omit<Extract<ExtensionToWebviewMessage, { type: 'requestThemeInstall' }>, 'type'> & { readonly progress?: Readonly<Record<string, number>> };

// Desktop only: core raises these prompts for the agent's theme tools, which VS Code never builds. Core answers an answer it
// does not take by posting the prompt again, so every setter replaces the entry it holds: a card sees its answer was answered.
export const useThemePromptStore = defineStore('themePrompts', () => {
  const changePrompts = ref<ThemeChangePromptView[]>([]);
  const screenshotPrompts = ref<ThemeScreenshotPromptView[]>([]);
  const installPrompts = ref<ThemeInstallPromptView[]>([]);
  // this chat's screenshot grant as its publisher last sent it (themeScreenshotGrant): no conversation reset clears it
  const screenshotGrant = ref(false);

  const put = <T extends { readonly promptId: string }>(list: readonly T[], prompt: T): T[] =>
    (list.some((held) => held.promptId === prompt.promptId) ? list.map((held) => (held.promptId === prompt.promptId ? prompt : held)) : [...list, prompt]);

  function setChangePrompt(prompt: ThemeChangePromptView): void {
    changePrompts.value = put(changePrompts.value, prompt);
  }

  function updateChangePrompt(promptId: string, update: ThemeCardUpdate): void {
    changePrompts.value = changePrompts.value.map((held) => (held.promptId === promptId ? applyThemeChangeUpdate(held, update) : held));
  }

  function removeChangePrompt(promptId: string): void {
    changePrompts.value = changePrompts.value.filter((held) => held.promptId !== promptId);
  }

  function setScreenshotPrompt(prompt: ThemeScreenshotPromptView): void {
    screenshotPrompts.value = put(screenshotPrompts.value, prompt);
  }

  function setScreenshotGrant(granted: boolean): void {
    screenshotGrant.value = granted;
  }

  function removeScreenshotPrompt(promptId: string): void {
    screenshotPrompts.value = screenshotPrompts.value.filter((held) => held.promptId !== promptId);
  }

  // A prompt posted again for the same staged install keeps the progress of its running flash checks.
  function setInstallPrompt(prompt: ThemeInstallPromptView): void {
    const held = installPrompts.value.find((known) => known.promptId === prompt.promptId);
    const progress = held?.preview.installId === prompt.preview.installId ? held.progress : undefined;
    const { progress: _own, ...rest } = prompt;
    installPrompts.value = put(installPrompts.value, { ...rest, preview: takeInstallThumbs(prompt.promptId, prompt.preview), ...(progress ? { progress } : {}) });
  }

  function updateInstallPrompt(promptId: string, preview: ThemeInstallPromptView['preview']): void {
    if (!installPrompts.value.some((held) => held.promptId === promptId)) return;
    const kept = takeInstallThumbs(promptId, preview);
    installPrompts.value = installPrompts.value.map((held) => (held.promptId === promptId ? { ...held, preview: kept } : held));
  }

  function updateInstallProgress(promptId: string, sha256: string, fraction: number): void {
    installPrompts.value = installPrompts.value.map((held) => (held.promptId === promptId ? { ...held, progress: { ...held.progress, [sha256]: fraction } } : held));
  }

  function removeInstallPrompt(promptId: string): void {
    installPrompts.value = installPrompts.value.filter((held) => held.promptId !== promptId);
    dropInstallThumbs(promptId);
  }

  /** The open prompt a ThemeRead, ThemeSet or ThemeSchedule call waits on, if any. */
  function awaitedBy(toolUseId: string): boolean {
    return [changePrompts.value, screenshotPrompts.value, installPrompts.value].some((prompts) => prompts.some((held) => held.toolUseId === toolUseId));
  }

  function $reset(): void {
    changePrompts.value = [];
    screenshotPrompts.value = [];
    installPrompts.value = [];
    dropInstallThumbs();
  }

  return {
    changePrompts, screenshotPrompts, installPrompts, screenshotGrant,
    setChangePrompt, updateChangePrompt, removeChangePrompt, setScreenshotPrompt, removeScreenshotPrompt, setScreenshotGrant,
    setInstallPrompt, updateInstallPrompt, updateInstallProgress, removeInstallPrompt, awaitedBy,
    $reset,
  };
});
