import { createApp, type App } from 'vue';
import type { ThemeRenderAnswer, ThemeRenderJob } from '@shared/themes/agent';
import { applyHostTheme } from '../../preload/apply-theme';
import { shellI18n } from '../i18n';
import SampleWindow from './SampleWindow.vue';
import { settled } from './settle';
import { createTranscriptApp } from './transcript-app';

type WindowJob = Extract<ThemeRenderJob, { kind: 'window' }>;

/** The rect of `element` in whole CSS px, inside the job's `width` x `height`. */
function regionOf(element: Element, width: number, height: number): NonNullable<ThemeRenderAnswer['region']> {
  const box = element.getBoundingClientRect();
  const x = Math.max(0, Math.floor(box.left));
  const y = Math.max(0, Math.floor(box.top));
  return { x, y, width: Math.min(width, Math.ceil(box.right)) - x, height: Math.min(height, Math.ceil(box.bottom)) - y };
}

/**
 * Draws the sample window into `host`, themed with the job's appearance, and answers once it is painted (settle.ts), its
 * wallpapers drawn. `own` takes the apps as they are made, so the page unmounts them before its next job. Whatever settle.ts
 * collects fails the job, so a window with a broken component or a missing file never passes as drawn.
 */
export async function drawWindow(job: WindowJob, host: HTMLElement, own: (apps: readonly App[]) => void): Promise<ThemeRenderAnswer> {
  const { appearance } = job;
  const { shellCss, chatCss } = appearance;
  const customCss = shellCss === undefined && chatCss === undefined ? undefined : [shellCss, chatCss].filter((css) => css !== undefined).join('\n');
  applyHostTheme({ kind: appearance.kind, css: appearance.css, trustedCss: appearance.trustedCss, ...(customCss === undefined ? {} : { customCss }), reducedMotion: true, fileIconTheme: 'material' });

  const now = Date.now();
  const shell = createApp(SampleWindow, { appearance, now }).use(shellI18n);
  const transcript = createTranscriptApp(appearance.platform, now);
  own([shell, transcript]);
  await settled('the sample window', host, [shell, transcript], () => {
    const sample = shell.mount(host) as unknown as { readonly chatSlot: HTMLElement | null; whenDrawn(): Promise<void> };
    // a window that threw while rendering mounts nothing
    if (!sample.chatSlot) throw new Error('the sample window has no chat slot');
    transcript.mount(sample.chatSlot);
    return () => sample.whenDrawn();
  });
  if (!host.querySelector('.code-block-content pre.shiki')) throw new Error('the sample code block did not highlight');
  if (job.view === 'window') return { drawn: true, width: job.width, height: job.height };
  const sidebar = host.querySelector('[data-render-region="sidebar"]');
  if (!sidebar) throw new Error('the sample window has no sidebar region');
  return { drawn: true, width: job.width, height: job.height, region: regionOf(sidebar, job.width, job.height) };
}
