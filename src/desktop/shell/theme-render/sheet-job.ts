import { createApp, type App } from 'vue';
import type { ThemeRenderAnswer, ThemeRenderJob } from '@shared/themes/agent';
import { BUILTIN_UI_STACK } from '@shared/themes/fonts';
import { applyHostTheme } from '../../preload/apply-theme';
import { shellI18n } from '../i18n';
import CharacterSheet from './CharacterSheet.vue';
import { settled } from './settle';

type SheetJob = Extract<ThemeRenderJob, { kind: 'characters' }>;

// The sheet's text at the default size, line spacing and Damocles' font whatever the user's text size and the theme's style, as
// the layout's px boxes assume (character-sheet.ts); the theme's density stays, which the layout's sidebar avatar carries.
const PINNED_ROOT = `:root { --d-font: ${BUILTIN_UI_STACK}; --d-font-size: 13px; --d-line-scale: 1; }`;

/**
 * Draws one page of a character sheet into `host`, themed with the job's appearance and its text pinned (PINNED_ROOT), and
 * answers once it is painted (settle.ts). `own` takes the app as it is made, so the page unmounts it before its next job.
 * Whatever settle.ts collects fails the job, so a cell never passes drawn wrong.
 */
export async function drawSheet(job: SheetJob, host: HTMLElement, own: (apps: readonly App[]) => void): Promise<ThemeRenderAnswer> {
  const { appearance } = job;
  applyHostTheme({ kind: appearance.kind, css: `${appearance.css}\n${PINNED_ROOT}`, trustedCss: appearance.trustedCss, reducedMotion: true, fileIconTheme: 'material' });

  const app = createApp(CharacterSheet, { appearance, sheet: job.sheet, characters: job.characters }).use(shellI18n);
  own([app]);
  await settled('the character sheet', host, [app], () => {
    app.mount(host);
    return undefined;
  });
  if (!host.querySelector('[data-testid="character-sheet"]')) throw new Error('the character sheet did not draw');
  return { drawn: true, width: job.width, height: job.height };
}
