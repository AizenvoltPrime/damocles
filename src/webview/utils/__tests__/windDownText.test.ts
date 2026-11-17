// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentWindDown } from '@shared/types/wind-down';
import { applyLocale, i18n } from '@/i18n';
import { windDownText } from '../windDownText';

const t = (key: string, params: Record<string, unknown>): string => i18n.global.t(key, params);
const SETTLE: AgentWindDown = { phase: 'settle', events: ['agent_settled'], extensions: [] };

afterEach(() => applyLocale('en'));

describe('the line a slow stop shows', () => {
  it('names a running Stop hook by its label and the hooks file that set it, ahead of an extension', () => {
    expect(windDownText({ ...SETTLE, extensions: ['/x/held.js'], hooks: [{ label: 'notify.sh', scope: 'project' }] }, t))
      .toBe('Stopping: waiting for the end-of-turn hook notify.sh (project hooks) to finish.');
    expect(windDownText({ ...SETTLE, hooks: [{ label: 'notify.ps1', scope: 'user' }] }, t))
      .toBe('Stopping: waiting for the end-of-turn hook notify.ps1 (user hooks) to finish.');
  });

  it('names a file-loaded extension in the settle phase by its file, or its folder for an index file', () => {
    expect(windDownText({ ...SETTLE, extensions: ['C:\\Users\\me\\.pi\\agent\\extensions\\held.js'] }, t))
      .toBe('Stopping: waiting for the end-of-turn step of the extension held.js.');
    expect(windDownText({ ...SETTLE, extensions: ['/home/me/.pi/agent/extensions/notifier/index.ts'] }, t))
      .toBe('Stopping: waiting for the end-of-turn step of the extension notifier.');
  });

  it('says running tools in the run phase, whatever extensions are loaded', () => {
    expect(windDownText({ phase: 'run', events: [], extensions: ['/x/held.js'] }, t)).toBe('Stopping: waiting for running tools to finish.');
  });

  it('says it finishes the turn when nothing it can name holds it', () => {
    expect(windDownText(SETTLE, t)).toBe('Stopping: finishing the turn.');
    expect(windDownText({ phase: 'start', events: ['input', 'before_agent_start'], extensions: ['/x/held.js'] }, t)).toBe('Stopping: finishing the turn.');
  });

  it('never words the engine: no pi, handler, event name or abort signal', async () => {
    const cases: AgentWindDown[] = [
      { ...SETTLE, hooks: [{ label: 'notify.sh', scope: 'user' }] },
      { ...SETTLE, extensions: ['/x/held.js'] },
      { phase: 'run', events: [], extensions: [] },
      { phase: 'start', events: ['input', 'before_agent_start'], extensions: [] },
    ];
    for (const locale of ['en', 'el'] as const) {
      await applyLocale(locale);
      for (const windDown of cases) {
        expect(windDownText(windDown, t)).not.toMatch(/\bpi\b|handler|χειριστ|agent_settled|before_agent_start|abort|ακύρωσ/i);
      }
    }
  });

  it('renders Greek', async () => {
    await applyLocale('el');
    expect(windDownText({ ...SETTLE, hooks: [{ label: 'notify.sh', scope: 'project' }] }, t))
      .toBe('Γίνεται διακοπή: αναμονή να τελειώσει το hook τέλους γύρου notify.sh (hooks έργου).');
  });
});
