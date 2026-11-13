// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import JobLogTab from '../forge/JobLogTab.vue';
import { releaseJobLogSessions } from '../forge/job-log-session';
import { findLogMatches, MAX_LOG_MATCHES, nextLogMatch, previousLogMatch, type LogRows } from '../forge/log-find';
import { ciColor, rowPieces, visibleRowIndexes } from '../forge/log-model';
import { applyShellLocale, shellI18n } from '../i18n';
import { CiLogParser, rowText, type CiLogRow, type CiLogSection } from '../../../shared/forge/ci-log';
import type { CiJobView, JobLogView } from '../../../shared/forge/ci';
import type { ShellEditorTab } from '../../preload/shell-channels';
import { fakeShellApi, type FakeShellApi } from './fakes';

const E = '\u001b';
// a sample log: two sections GitLab starts folded, then the open step_script section
const LOG = [
  `${E}[0K${E}[90mRunning with gitlab-runner 17.9.1 (a1b2c3d4)${E}[0m`,
  `section_start:1700000000:prepare_executor[collapsed=true]\r${E}[0K${E}[36;1mPreparing the "docker" executor${E}[0;m`,
  'Using Docker executor with image node:24-bookworm ...',
  'Pulling docker image node:24-bookworm ...',
  `section_end:1700000004:prepare_executor\r${E}[0K`,
  `section_start:1700000005:get_sources[collapsed=true]\r${E}[0K${E}[36;1mGetting source from Git repository${E}[0;m`,
  'Fetching changes with git depth set to 20...',
  `section_end:1700000008:get_sources\r${E}[0K`,
  `section_start:1700000009:step_script\r${E}[0K${E}[36;1mExecuting "step_script" stage of the job script${E}[0;m`,
  `${E}[32;1m$ npm ci${E}[0;m`,
  'added 1284 packages in 21s',
  `${E}[32;1m$ npm test -- src/core/forge${E}[0;m`,
  '',
].join('\n');

const UNIT: CiJobView = { id: 501, name: 'unit', stage: 'test', state: 'running', kind: 'job', durationSeconds: 150, canRetry: false, canCancel: true, hasLog: true };
const readyView = (extra: Partial<Extract<JobLogView, { status: 'ready' }>> = {}): JobLogView => ({
  status: 'ready', job: UNIT, pipeline: { id: 99_001, number: 4312 }, serverName: 'gitlab.indigital.gr', kind: 'gitlab', reset: true, text: LOG, truncated: false, live: true, ...extra,
});
const TAB: ShellEditorTab & { jobLog: NonNullable<ShellEditorTab['jobLog']> } = {
  id: 'tab-1', kind: 'jobLog', title: 'unit', displayPath: 'unit #4312', dirty: false, readOnly: true, conflict: false,
  jobLog: { repoId: 'r1', jobId: 501, jobName: 'unit', pipelineNumber: 4312, state: 'running' },
};

const mounted: VueWrapper[] = [];
beforeEach(async () => {
  await applyShellLocale('en');
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mountTab(view: JobLogView | undefined = readyView()): Promise<{ wrapper: VueWrapper; api: FakeShellApi }> {
  const api = fakeShellApi();
  if (view) api.forge.jobLogs.set(TAB.id, view);
  const wrapper = mount(JobLogTab, { props: { api, tab: TAB }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, api };
}

const textRows = (texts: readonly string[]): LogRows => ({ count: texts.length, at: (index) => ({ spans: [{ text: texts[index]! }] }) });
const named = (role: string, name: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(role === 'button' ? 'button' : `[role="${role}"]`)].find((each) => each.getAttribute('aria-label') === name);
const log = (): HTMLElement => named('log', 'unit log')!;
const renderedLines = (): string[] => [...document.querySelectorAll('[data-testid="job-log-text"]')].map((each) => each.textContent ?? '');

// happy-dom lays nothing out: give the log a viewport and a content height, so following and scrolling away can be told apart
function layout(element: HTMLElement, sizes: { clientHeight: number; scrollHeight: number }): void {
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => sizes.clientHeight });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => sizes.scrollHeight });
}

describe('the job log model', () => {
  it('collapses folded sections in the row indexes, an open folded section to the end', () => {
    const parser = new CiLogParser('gitlab');
    parser.push(LOG);
    parser.end();
    const sections = new Map(parser.sections.map((section) => [section.id, section]));
    expect(visibleRowIndexes(parser.rows, sections, new Set())).toHaveLength(parser.rows.length);
    expect(visibleRowIndexes(parser.rows, sections, new Set([0, 1])).map((index) => rowText(parser.rows[index]!))).toEqual([
      'Running with gitlab-runner 17.9.1 (a1b2c3d4)',
      'Preparing the "docker" executor',
      'Getting source from Git repository',
      'Executing "step_script" stage of the job script',
      '$ npm ci',
      'added 1284 packages in 21s',
      '$ npm test -- src/core/forge',
    ]);
    const open: CiLogSection = { id: 9, title: 'open', name: 'open', depth: 0, headerRow: 1, collapsed: false };
    const rows: CiLogRow[] = [0, 1, 2, 3].map((line) => ({ line: line + 1, spans: [], ...(line === 1 ? { header: 9, section: 9 } : line > 1 ? { section: 9 } : {}) }));
    expect(visibleRowIndexes(rows, new Map([[9, open]]), new Set([9]))).toEqual([0, 1]);
  });

  it('maps the 16 colours to the theme tokens and the parser-computed ones to rgb', () => {
    expect(ciColor({ palette: 1 })).toBe('var(--d-ansi-1)');
    expect(ciColor({ palette: 15 })).toBe('var(--d-ansi-15)');
    expect(ciColor({ rgb: [10, 20, 30] })).toBe('rgb(10 20 30)');
  });

  it('cuts spans at match edges and stops counting at the bound', () => {
    const pieces = rowPieces([{ text: 'npm ' }, { text: 'test', bold: true }], [{ start: 2, end: 6, current: true }]);
    expect(pieces.map((piece) => [piece.text, piece.mark ?? ''])).toEqual([['np', ''], ['m ', 'current'], ['te', 'current'], ['st', '']]);
    const many = textRows(Array.from({ length: MAX_LOG_MATCHES + 5 }, () => 'x'));
    expect(findLogMatches(many, 'x', {})).toHaveLength(MAX_LOG_MATCHES);
    expect(findLogMatches(textRows(['unit units']), 'unit', { wholeWord: true })).toEqual([{ row: 0, start: 0, end: 4 }]);
    expect(findLogMatches(textRows(['Unit']), 'unit', { caseSensitive: true })).toEqual([]);
    expect(findLogMatches(textRows(['a1 b22']), '\\d+', { regex: true })).toEqual([{ row: 0, start: 1, end: 2 }, { row: 0, start: 4, end: 6 }]);
  });

  it('steps to matches past the bound, both ways from the current one, wrapping', () => {
    const rows = textRows([...Array.from({ length: MAX_LOG_MATCHES + 2 }, () => 'x'), 'x and x']);
    const pattern = /x/g;
    const last = { row: MAX_LOG_MATCHES + 2, start: 6, end: 7 };
    // Previous with no current match goes to the log's last match, not the bound's
    expect(previousLogMatch(rows, pattern, undefined)).toEqual(last);
    expect(nextLogMatch(rows, pattern, { row: MAX_LOG_MATCHES + 1, start: 0, end: 1 }, false)).toEqual({ row: MAX_LOG_MATCHES + 2, start: 0, end: 1 });
    expect(nextLogMatch(rows, pattern, { row: MAX_LOG_MATCHES + 2, start: 0, end: 1 }, false)).toEqual(last);
    expect(nextLogMatch(rows, pattern, last, false)).toEqual({ row: 0, start: 0, end: 1 });
    expect(nextLogMatch(rows, pattern, last, true)).toEqual(last);
    expect(previousLogMatch(rows, pattern, { row: 0, start: 0, end: 1 })).toEqual(last);
    expect(previousLogMatch(rows, pattern, last)).toEqual({ row: MAX_LOG_MATCHES + 2, start: 0, end: 1 });
    expect(nextLogMatch(textRows(['only x here']), /x/g, { row: 0, start: 5, end: 6 }, false)).toEqual({ row: 0, start: 5, end: 6 });
  });

  it('cuts every direction control into a piece of its own, named, inside a match too', () => {
    const controls = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f\u061c';
    expect(rowPieces([{ text: controls }], []).map((piece) => piece.control?.name)).toEqual(['LRE', 'RLE', 'PDF', 'LRO', 'RLO', 'LRI', 'RLI', 'FSI', 'PDI', 'LRM', 'RLM', 'ALM']);
    const pieces = rowPieces([{ text: 'ab\u202edc' }, { text: 'x\u2067', bold: true }], [{ start: 1, end: 4, current: false }]);
    expect(pieces.map((piece) => [piece.text, piece.mark ?? '', piece.control?.code ?? ''])).toEqual([
      ['a', '', ''], ['b', 'match', ''], ['\u202e', 'match', 'U+202E'], ['d', 'match', ''], ['c', '', ''], ['x', '', ''], ['\u2067', '', 'U+2067'],
    ]);
    expect(rowPieces([{ text: 'plain \u05d0 text' }], [])).toEqual([{ text: 'plain \u05d0 text', span: { text: 'plain \u05d0 text' } }]);
  });
});

describe('the job log tab', () => {
  it('shows the log as role log named "<job> log", not live, with folded sections as the log says', async () => {
    await mountTab();
    expect(log().getAttribute('aria-live')).toBe('off');
    expect(log().textContent).toContain('npm ci');
    // [collapsed=true] starts folded
    expect(named('button', 'Unfold Preparing the "docker" executor')).toBeDefined();
    expect(named('button', 'Unfold Getting source from Git repository')).toBeDefined();
    expect(renderedLines()).not.toContain('Pulling docker image node:24-bookworm ...');
    const folded = named('button', 'Unfold Preparing the "docker" executor')!.closest('[data-testid="job-log-row"]')!;
    expect(folded.querySelector('[data-testid="job-log-folded"]')!.textContent).toBe('2 lines');
    expect(folded.querySelector('[data-testid="job-log-duration"]')!.textContent).toBe('4s');
  });

  it('folds and unfolds a section by its button, and folds every section with Fold all sections', async () => {
    await mountTab();
    named('button', 'Fold Executing "step_script" stage of the job script')!.click();
    await flushPromises();
    expect(named('button', 'Unfold Executing "step_script" stage of the job script')!.getAttribute('aria-expanded')).toBe('false');
    expect(renderedLines()).not.toContain('$ npm ci');
    named('button', 'Unfold Preparing the "docker" executor')!.click();
    await flushPromises();
    expect(renderedLines()).toContain('Pulling docker image node:24-bookworm ...');
    named('button', 'Fold all sections')!.click();
    await flushPromises();
    expect([...document.querySelectorAll('[data-testid="job-log-fold"]')].map((each) => each.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false']);
  });

  it('shows the timestamp column until Timestamps is turned off', async () => {
    await mountTab();
    const toggle = named('button', 'Timestamps')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelectorAll('[data-testid="job-log-stamp"]').length).toBeGreaterThan(0);
    toggle.click();
    await flushPromises();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelectorAll('[data-testid="job-log-stamp"]')).toHaveLength(0);
    expect(log().textContent).toContain('Preparing the');
  });

  it('keeps only a window of a 100,000-line log in the DOM', async () => {
    const text = Array.from({ length: 100_000 }, (_, index) => `line ${index + 1}`).join('\n');
    await mountTab(readyView({ text, live: false, job: { ...UNIT, state: 'passed', canCancel: false, canRetry: true } }));
    const rows = document.querySelectorAll('[data-testid="job-log-row"]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
  });

  it('finds text in folded and windowed-out lines, unfolding the section that holds it', async () => {
    const tail = Array.from({ length: 5_000 }, (_, index) => `filler ${index}`).join('\n');
    const text = `${LOG}${tail}\nsection_start:1700000100:deep[collapsed=true]\r${E}[0KDeep section\nthe needle is here\nsection_end:1700000101:deep\r${E}[0K\n`;
    const { wrapper } = await mountTab(readyView({ text, live: false, job: { ...UNIT, state: 'failed', canCancel: false, canRetry: true } }));
    expect(renderedLines()).not.toContain('the needle is here');
    log().dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true }));
    await flushPromises();
    const input = wrapper.get<HTMLInputElement>('[data-testid="terminal-find-input"]');
    expect(input.attributes('aria-label')).toBe('Find in log');
    await input.setValue('needle');
    await flushPromises();
    expect(wrapper.get('[data-testid="terminal-find-status"]').text()).toBe('1 of 1');
    expect(named('button', 'Fold Deep section')).toBeDefined();
    expect(renderedLines()).toContain('the needle is here');

    // a match in a section folded from the start (Pulling docker image), found from the find bar's next match
    await input.setValue('Pulling');
    await flushPromises();
    expect(named('button', 'Fold Preparing the "docker" executor')).toBeDefined();
    expect(renderedLines()).toContain('Pulling docker image node:24-bookworm ...');
  });

  it('appends each push to the parser without parsing the log again, and follows the end', async () => {
    const push = vi.spyOn(CiLogParser.prototype, 'push');
    const { api } = await mountTab();
    expect(push).toHaveBeenCalledTimes(1);
    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ reset: false, text: ' ✓ src/core/forge/__tests__/refresh.test.ts (9 tests)\n' }) });
    await flushPromises();
    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenLastCalledWith(' ✓ src/core/forge/__tests__/refresh.test.ts (9 tests)\n');
    expect(renderedLines()).toContain(' ✓ src/core/forge/__tests__/refresh.test.ts (9 tests)');
    expect(document.querySelector('[data-testid="job-log-running"]')!.textContent).toBe('Running. New output appears every few seconds.');
    api.forge.jobLogUpdate({ tabId: 'other', view: readyView({ reset: false, text: 'not mine\n' }) });
    await flushPromises();
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('turns Follow off when scrolled away and shows New output for later lines; the pill follows again', async () => {
    const { api } = await mountTab();
    const element = log();
    const sizes = { clientHeight: 200, scrollHeight: 2000 };
    layout(element, sizes);
    expect(named('button', 'Follow')!.getAttribute('aria-pressed')).toBe('true');
    element.scrollTop = 100;
    element.dispatchEvent(new Event('scroll'));
    await flushPromises();
    expect(named('button', 'Follow')!.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('[data-testid="job-log-new-output"]')).toBeNull();
    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ reset: false, text: 'more output\n' }) });
    await flushPromises();
    const pill = document.querySelector<HTMLElement>('[data-testid="job-log-new-output"]')!;
    expect(pill.textContent).toContain('New output');
    pill.click();
    await flushPromises();
    expect(named('button', 'Follow')!.getAttribute('aria-pressed')).toBe('true');
    expect(element.scrollTop).toBe(2000);
  });

  it('says Passed in … once the job finished, and announces the finish once', async () => {
    const { wrapper, api } = await mountTab();
    const passed = { ...UNIT, state: 'passed' as const, durationSeconds: 221, canCancel: false, canRetry: true };
    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ reset: false, text: 'Job succeeded\n', live: false, job: passed }) });
    await flushPromises();
    expect(wrapper.get('[data-testid="job-log-tail"]').text()).toBe('Passed in 3m 41s.');
    expect(wrapper.find('[data-testid="job-log-running"]').exists()).toBe(false);
    const status = wrapper.get('[data-testid="job-log-status"]');
    expect(status.text()).toBe('unit passed.');
    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ reset: false, text: '', live: false, job: passed }) });
    await flushPromises();
    expect(status.text()).toBe('unit passed.');
  });

  it('cancels the job and hands focus to Retry job when it replaces Cancel job', async () => {
    const { api } = await mountTab();
    const cancel = named('button', 'Cancel job')!;
    cancel.focus();
    cancel.click();
    await flushPromises();
    expect(api.forge.jobAction).toHaveBeenCalledWith('r1', { jobId: 501 }, 'cancel');
    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ reset: false, text: '', live: false, job: { ...UNIT, state: 'canceled', canCancel: false, canRetry: true } }) });
    await flushPromises();
    expect(named('button', 'Cancel job')).toBeUndefined();
    expect(document.activeElement).toBe(named('button', 'Retry job'));
  });

  it('reads the whole log again when text arrives after the finish, and opens Find from the toolbar', async () => {
    const { api } = await mountTab();
    const finished = { ...UNIT, state: 'passed' as const, canCancel: false, canRetry: true };
    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ reset: false, text: '', live: false, job: finished }) });
    await flushPromises();
    api.forge.jobLogs.set(TAB.id, readyView({ text: 'whole again\n', live: false, job: finished }));
    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ reset: false, text: 'late line\n', live: false, job: finished }) });
    await flushPromises();
    expect(api.forge.jobLog).toHaveBeenCalledTimes(2);
    expect(renderedLines()).toEqual(['whole again']);

    named('button', 'Timestamps')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true }));
    await flushPromises();
    expect(document.querySelector('[data-testid="terminal-find-input"]')).not.toBeNull();
  });

  it('shows a held GitLab-stamped line as a provisional last row until the next line settles it', async () => {
    const { api } = await mountTab(readyView({ text: '2026-05-04T09:12:30.000000Z 00O $ npm ci\n' }));
    const rows = (): Element[] => [...document.querySelectorAll('[data-testid="job-log-row"]')];
    expect(rows().map((row) => [row.textContent?.includes('$ npm ci'), row.getAttribute('data-provisional')])).toEqual([[true, 'true']]);
    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ reset: false, text: '2026-05-04T09:12:31.000000Z 00O+ --quiet\n2026-05-04T09:12:32.000000Z 00O next\n' }) });
    await flushPromises();
    expect(renderedLines()).toEqual(['$ npm ci --quiet', 'next']);
    expect(rows().map((row) => row.getAttribute('data-provisional'))).toEqual([null, 'true']);
  });

  it("shows GitHub's error, warning and notice lines with their level named and toned", async () => {
    await mountTab(readyView({ kind: 'github', live: false, text: '##[error]Process completed with exit code 1.\n##[warning]Deprecated\n##[notice]Cache restored\nplain\n', job: { ...UNIT, state: 'failed', canCancel: false, canRetry: true } }));
    expect(renderedLines()).toEqual(['Error:Process completed with exit code 1.', 'Warning:Deprecated', 'Notice:Cache restored', 'plain']);
    const tones = [...document.querySelectorAll('[data-testid="job-log-text"]')].map((each) => [...each.classList].find((name) => name.startsWith('text-(')));
    expect(tones).toEqual(['text-(--d-danger-text)', 'text-(--d-warning-text)', 'text-(--d-info-text)', 'text-(--d-text)']);
    expect([...document.querySelectorAll('[data-testid="job-log-row"]')].map((row) => row.getAttribute('data-level'))).toEqual(['error', 'warning', 'notice', null]);
  });

  it('shows a direction control as its name with a label, so it cannot reorder the line', async () => {
    await mountTab(readyView({ text: 'safe \u202eexe.txt\n' }));
    const control = document.querySelector<HTMLElement>('[data-control="U+202E"]')!;
    expect(control.getAttribute('role')).toBe('img');
    expect(control.getAttribute('aria-label')).toBe('Text direction character RLO, U+202E');
    expect(renderedLines()).toEqual(['safe RLOexe.txt']);
    expect(document.querySelector('[data-testid="job-log-text"]')!.textContent).not.toContain('\u202e');
  });

  it('starts a new parser on a reset, as a retry\'s new job sends', async () => {
    const { api } = await mountTab();
    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ reset: true, text: 'fresh start\n', job: { ...UNIT, id: 502 } }) });
    await flushPromises();
    expect(renderedLines()).toEqual(['fresh start']);
  });

  it('shows a skeleton while loading, and the error with its cause, Try again and Open on <server>', async () => {
    const { wrapper, api } = await mountTab({ status: 'loading' });
    expect(wrapper.get('[data-testid="job-log-loading"]').attributes('aria-busy')).toBe('true');
    expect(wrapper.find('[role="log"]').exists()).toBe(false);

    api.forge.jobLogUpdate({ tabId: TAB.id, view: { status: 'error', message: 'gitlab.indigital.gr did not answer in 25 seconds.', job: UNIT, serverName: 'gitlab.indigital.gr' } });
    await flushPromises();
    const error = wrapper.get('[data-testid="job-log-error"]');
    expect(error.attributes('role')).toBe('alert');
    expect(error.text()).toContain('Damocles could not read this log');
    expect(error.text()).toContain('gitlab.indigital.gr did not answer in 25 seconds.');
    expect([...error.element.querySelectorAll('button')].map((each) => each.textContent?.trim())).toEqual(['Try again', 'Open on gitlab.indigital.gr']);

    api.forge.jobLogs.set(TAB.id, readyView());
    await wrapper.get('[data-testid="job-log-try-again"]').trigger('click');
    await flushPromises();
    expect(api.forge.jobLog).toHaveBeenCalledTimes(2);
    expect(log().textContent).toContain('npm ci');
  });

  it('shows a running GitHub job\'s steps until its log is served, with Open on GitHub', async () => {
    const steps = [{ number: 1, name: 'Set up job', state: 'passed' as const }, { number: 2, name: 'npm test', state: 'running' as const }, { number: 3, name: 'Upload coverage', state: 'pending' as const }];
    const { wrapper, api } = await mountTab({ status: 'githubRunning', job: { ...UNIT, name: 'test', steps }, serverName: 'github.com' });
    const list = wrapper.get('[data-testid="job-log-steps"]');
    expect(list.attributes('aria-label')).toBe('Steps of test');
    expect(list.findAll('li').map((each) => each.text())).toEqual(['Set up job, passed', 'npm test, running', 'Upload coverage, pending']);
    await wrapper.get('[data-testid="job-log-open-github"]').trigger('click');
    await flushPromises();
    expect(api.forge.openOnServer).toHaveBeenCalledWith('r1', { jobId: 501 });

    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ live: false, job: { ...UNIT, state: 'passed', canCancel: false, canRetry: true } }) });
    await flushPromises();
    expect(log().textContent).toContain('npm ci');
  });

  it('reports the tab shown and hidden for its log poll', async () => {
    const { wrapper, api } = await mountTab();
    expect(api.forge.jobLogVisible).toHaveBeenCalledWith(TAB.id, true);
    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);
    expect(api.forge.jobLogVisible).toHaveBeenLastCalledWith(TAB.id, false);
  });

  it('keeps the log under a later failed read, says why above it, and reads again on Try again', async () => {
    const { wrapper, api } = await mountTab();
    named('button', 'Fold Executing "step_script" stage of the job script')!.click();
    await flushPromises();
    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ reset: false, text: '', error: 'Could not reach gitlab.indigital.gr. Check the connection and try again.' }) });
    await flushPromises();
    const banner = wrapper.get('[data-testid="job-log-banner"]');
    expect(banner.attributes('role')).toBe('alert');
    expect(banner.text()).toContain('Could not read new output. Could not reach gitlab.indigital.gr.');
    // the log, its folds and its parser stay
    expect(named('button', 'Unfold Executing "step_script" stage of the job script')).toBeDefined();
    expect(wrapper.find('[data-testid="job-log-error"]').exists()).toBe(false);
    let read!: () => void;
    vi.mocked(api.forge.jobLogRead).mockImplementation(() => new Promise<void>((resolve) => (read = resolve)));
    const again = wrapper.get('[data-testid="job-log-banner-try-again"]');
    await again.trigger('click');
    await again.trigger('click');
    expect(api.forge.jobLogRead).toHaveBeenCalledTimes(1);
    expect(api.forge.jobLogRead).toHaveBeenCalledWith(TAB.id);
    expect(again.attributes('aria-disabled')).toBe('true');
    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ reset: false, text: 'back again\n' }) });
    read();
    await flushPromises();
    expect(wrapper.find('[data-testid="job-log-banner"]').exists()).toBe(false);
    expect(named('button', 'Unfold Executing "step_script" stage of the job script')).toBeDefined();
    // an error view over a held log is that failure too
    api.forge.jobLogUpdate({ tabId: TAB.id, view: { status: 'error', message: 'The repository of this job is no longer open.' } });
    await flushPromises();
    expect(wrapper.get('[data-testid="job-log-banner"]').text()).toContain('The repository of this job is no longer open.');
    expect(log().textContent).toContain('Running with gitlab-runner');
  });

  it('keeps the parsed log while the tab is hidden, and parses or reads nothing again when it shows', async () => {
    const push = vi.spyOn(CiLogParser.prototype, 'push');
    const { wrapper, api } = await mountTab();
    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);
    // an append while hidden still reaches the tab's parser
    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ reset: false, text: 'while hidden\n' }) });
    const again = mount(JobLogTab, { props: { api, tab: TAB }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(again);
    await flushPromises();
    expect(api.forge.jobLog).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(2);
    expect(renderedLines()).toContain('while hidden');

    // once the tab closes its log is let go: a tab of that id later reads it again
    again.unmount();
    mounted.splice(mounted.indexOf(again), 1);
    releaseJobLogSessions(api, new Set());
    api.forge.jobLogUpdate({ tabId: TAB.id, view: readyView({ reset: false, text: 'after close\n' }) });
    expect(push).toHaveBeenCalledTimes(2);
    mounted.push(mount(JobLogTab, { props: { api, tab: TAB }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();
    expect(api.forge.jobLog).toHaveBeenCalledTimes(2);
  });

  it('sends one action for a double click, saying it is under way', async () => {
    const { api } = await mountTab();
    let finish!: (done: boolean) => void;
    vi.mocked(api.forge.jobAction).mockImplementation(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const cancel = named('button', 'Cancel job')!;
    cancel.click();
    cancel.click();
    await flushPromises();
    expect(api.forge.jobAction).toHaveBeenCalledTimes(1);
    expect(cancel.getAttribute('aria-disabled')).toBe('true');
    finish(true);
    await flushPromises();
    expect(cancel.getAttribute('aria-disabled')).toBeNull();
  });

  it('moves along its toolbar with the arrow keys, one tab stop at a time', async () => {
    await mountTab();
    const toolbar = document.querySelector<HTMLElement>('[role="toolbar"]')!;
    const stops = (): string[] => [...toolbar.querySelectorAll<HTMLElement>('button')].filter((each) => each.tabIndex === 0).map((each) => each.getAttribute('aria-label')!);
    expect(stops()).toEqual(['Follow']);
    named('button', 'Follow')!.focus();
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flushPromises();
    expect(document.activeElement).toBe(named('button', 'Timestamps'));
    expect(stops()).toEqual(['Timestamps']);
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await flushPromises();
    expect(document.activeElement).toBe(named('button', 'Open on gitlab.indigital.gr'));
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flushPromises();
    expect(document.activeElement).toBe(named('button', 'Follow'));
  });

  it('counts matches up to the bound as "10,000+", and steps past it to the log\'s last match', async () => {
    const text = `${Array.from({ length: MAX_LOG_MATCHES + 4 }, (_, index) => `x ${index}`).join('\n')}\n`;
    const { wrapper } = await mountTab(readyView({ text, live: false, job: { ...UNIT, state: 'passed', canCancel: false, canRetry: true } }));
    log().dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true }));
    await flushPromises();
    await wrapper.get('[data-testid="terminal-find-input"]').setValue('x');
    await flushPromises();
    expect(wrapper.get('[data-testid="terminal-find-status"]').text()).toBe('1 of 10,000+');
    await wrapper.get('[data-testid="terminal-find-previous"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="terminal-find-status"]').text()).toBe('10,000+ results');
    expect(renderedLines()).toContain(`x ${MAX_LOG_MATCHES + 3}`);
  });

  it('finds text in the provisional last row, and marks a match on coloured text without its colours', async () => {
    const { wrapper } = await mountTab(readyView({ text: `${E}[41mred needle${E}[0m\n2026-05-04T09:12:30.000000Z 00O held needle\n` }));
    log().dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true }));
    await flushPromises();
    await wrapper.get('[data-testid="terminal-find-input"]').setValue('needle');
    await flushPromises();
    expect(wrapper.get('[data-testid="terminal-find-status"]').text()).toBe('1 of 2');
    const marked = [...document.querySelectorAll<HTMLElement>('[data-testid="job-log-text"] span')].filter((each) => each.textContent === 'needle');
    expect(marked).toHaveLength(2);
    for (const piece of marked) expect(piece.getAttribute('style')).toBeNull();
    expect(marked[1]!.closest('[data-testid="job-log-row"]')!.getAttribute('data-provisional')).toBe('true');
  });
});
