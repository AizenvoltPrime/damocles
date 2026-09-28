import type { Scene } from '../lib/scene.ts';
import { bootMessages } from '../lib/script.ts';
import type { Stage } from '../lib/stage.ts';
import { usageReport } from './stats-data.ts';

/** Wheel-scrolls in small steps so the motion reads as a smooth scroll on video. */
async function smoothScroll(stage: Stage, pixels: number, ms: number): Promise<void> {
  const steps = Math.max(1, Math.round(ms / 16));
  for (let i = 0; i < steps; i++) {
    await stage.page.mouse.wheel(0, pixels / steps);
    await stage.pause(16);
  }
}

export const stats: Scene = {
  id: 'stats',
  chapter: 'Usage stats',
  accent: 'magenta',
  boot: bootMessages({ mode: 'acceptEdits', yolo: true }),
  async run(stage) {
    await stage.caption('/stats shows spend across every project, model and agent.');
    stage.respond('requestUsageStats', (q) => [
      { type: 'usageStatsProgress', requestId: q.requestId, filesDone: 480, filesTotal: 480 },
      { type: 'usageStats', requestId: q.requestId, final: true, report: usageReport(q.query) },
    ]);
    const input = stage.page.locator('textarea').first();
    await stage.typeInto(input, '/stats ', { delayMs: 70 });
    await stage.pause(250);
    const opened = stage.waitForPost('requestUsageStats');
    await stage.page.keyboard.press('Enter');
    await opened;
    await stage.page.getByText('Usage over time').first().waitFor();
    stage.mark('gif-start');
    await stage.pause(2200);

    await stage.moveTo(stage.page.getByText('Usage over time').first());
    await stage.pause(400);
    await stage.caption('Daily cost by model, compared with the previous period.');
    await stage.focus([stage.page.getByText('Usage over time').first(), stage.page.getByText('By model', { exact: true }).first()], { maxZoom: 1.35 });
    await stage.pause(2000);
    stage.unfocus();
    await stage.pause(700);
    stage.mark('gif-end');
    await smoothScroll(stage, 460, 1300);
    await stage.caption('Broken down by model, project and source: main chat, subagents, teams.');
    await stage.pause(500);
    await stage.click(stage.page.locator('button[data-expand]').first());
    await stage.pause(1200);
    await stage.click(stage.page.locator('button[data-expand]').nth(1));
    await stage.pause(1300);
    await stage.caption('When you work, and which conversations cost the most.');
    await smoothScroll(stage, 700, 1500);
    await stage.pause(2600);
  },
};
