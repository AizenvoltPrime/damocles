import { describe, expect, it, vi } from 'vitest';
import type { CiLog, CiRepo } from '../../../../core/forge/ci-watch';
import type { CiJobView } from '../../../../shared/forge/ci';
import type { JobLogUpdate } from '../../../preload/forge-channels';
import type { ShellJobLogTab } from '../../../preload/shell-channels';
import type { CoreClient } from '../../core-client';
import { JobLogTabs } from '../job-log-tabs';

// The jobLog editor tab's feed (docs/invariants.md "Desktop host", job log tabs): one tab per job, the log pushed as appends,
// a remount answered with the whole text, a hidden tab or blurred window not read, a retried job followed.

const REPO: CiRepo = { authorityKey: 'local', project: 'damocles', endpoints: [], branch: 'feature/forge-accounts' };
const job = (id: number, state: CiJobView['state'] = 'running'): CiJobView => ({ id, name: 'unit', stage: 'test', state, kind: 'job', canRetry: false, canCancel: true, hasLog: true });
const ready = (id: number, text: string, reset: boolean, state: CiJobView['state'] = 'running'): Extract<CiLog, { status: 'ready' }> => ({ status: 'ready', job: job(id, state), pipeline: { id: 54312, number: 4312 }, serverName: 'gitlab.com', kind: 'gitlab', reset, text, truncated: false, live: state === 'running' });

function world() {
  const tabs = new Map<string, ShellJobLogTab>();
  const closers = new Map<string, () => void>();
  let focused = true;
  let running = true;
  // a local core restart gives the repository a new id
  let repoId = 'repo-1';
  const logs: string[] = [];
  const client = {
    forgeCiJobLog: vi.fn(async ({ jobId }: { jobId: number }): Promise<CiLog> => ready(jobId, 'line 1\n', true)),
    forgeCiWatch: vi.fn(async () => null),
    forgeCiUnwatch: vi.fn(async () => undefined),
    forgeCiJobs: vi.fn(async () => null),
  };
  const sent: JobLogUpdate[] = [];
  const pane = {
    showJobLog: vi.fn((jobLog: ShellJobLogTab) => {
      const existing = [...tabs].find(([, tab]) => tab.repoId === jobLog.repoId && tab.jobId === jobLog.jobId)?.[0];
      if (existing) return existing;
      const tabId = `tab-${tabs.size + 1}`;
      tabs.set(tabId, jobLog);
      return tabId;
    }),
    jobLogTab: (tabId: string) => tabs.get(tabId),
    updateJobLog: (tabId: string, jobLog: ShellJobLogTab) => void tabs.set(tabId, jobLog),
    whenClosed: (tabId: string) => new Promise<void>((resolve) => closers.set(tabId, resolve)),
  };
  const host = new JobLogTabs({
    core: (_label, work) => (running ? work(client as unknown as CoreClient) : Promise.reject(new Error('Core services are stopped for the quit'))),
    coreRunning: () => running,
    forge: {
      ciRepo: async (id) => (id === repoId ? REPO : undefined),
      ciJob: (_repoId, jobId) => (jobId === 9203 ? { name: 'unit', pipelineNumber: 4312, state: 'running' } : jobId === 9401 ? { name: 'test', workflow: 'CI', state: 'running' } : undefined),
      isWindowFocused: () => focused,
    },
    pane,
    render: (text) => text.message,
    t: (message) => message,
    send: (update) => sent.push(update),
    log: (line) => logs.push(line),
  });
  return {
    host, client, pane, tabs, sent, logs,
    close: (tabId: string) => closers.get(tabId)!(),
    blur: (value: boolean) => (focused = !value),
    stopCore: () => (running = false),
    renameRepo: (id: string) => (repoId = id),
  };
}

describe('job log tabs', () => {
  it('opens one tab per job, named from the job list, and starts the log watch', async () => {
    const w = world();
    await w.host.open('repo-1', 9203, { focus: true });
    await w.host.open('repo-1', 9203, { focus: true });
    expect(w.tabs.size).toBe(1);
    expect(w.pane.showJobLog).toHaveBeenNthCalledWith(1, { repoId: 'repo-1', jobId: 9203, jobName: 'unit', pipelineNumber: 4312, state: 'running' }, { focus: true });
    expect(w.client.forgeCiJobLog).toHaveBeenCalledTimes(1);
    expect(w.client.forgeCiJobLog).toHaveBeenCalledWith({ id: 'log:tab-1', repo: REPO, jobId: 9203 });
    expect(w.tabs.get('tab-1')).toEqual({ repoId: 'repo-1', jobId: 9203, jobName: 'unit', pipelineNumber: 4312, state: 'running' });
  });

  it('pushes appends as they come, and answers a remounted tab with the whole text', async () => {
    const w = world();
    await w.host.open('repo-1', 9203, { focus: true });
    w.host.coreLog('log:tab-1', ready(9203, 'line 2\n', false));
    w.host.coreLog('log:tab-1', ready(9203, 'line 3\n', false, 'passed'));
    expect(w.sent.map((update) => update.view.status === 'ready' ? [update.view.reset, update.view.text] : [])).toEqual([[false, 'line 2\n'], [false, 'line 3\n']]);
    expect(await w.host.jobLog('tab-1')).toMatchObject({ status: 'ready', reset: true, text: 'line 1\nline 2\nline 3\n', live: false });
    expect(w.tabs.get('tab-1')?.state).toBe('passed');
    w.host.coreLog('log:other', ready(9203, 'x', false));
    expect(w.sent).toHaveLength(2);
  });

  it('pauses the log while the tab is hidden or the window blurred, and ends the watch when the tab closes', async () => {
    const w = world();
    await w.host.open('repo-1', 9203, { focus: true });
    w.host.setVisible('tab-1', false);
    expect(w.client.forgeCiWatch).toHaveBeenLastCalledWith({ id: 'log:tab-1', active: false });
    w.host.setVisible('tab-1', true);
    expect(w.client.forgeCiWatch).toHaveBeenLastCalledWith({ id: 'log:tab-1', active: true });
    w.blur(true);
    w.host.setWindowFocused();
    expect(w.client.forgeCiWatch).toHaveBeenLastCalledWith({ id: 'log:tab-1', active: false });
    w.close('tab-1');
    await Promise.resolve();
    expect(w.client.forgeCiUnwatch).toHaveBeenCalledWith('log:tab-1');
    await expect(w.host.jobLog('tab-1')).rejects.toThrow('No such job log tab');
  });

  it('follows a retried job to its new id from the start of its log', async () => {
    const w = world();
    await w.host.open('repo-1', 9203, { focus: true });
    w.client.forgeCiJobLog.mockResolvedValueOnce(ready(9300, 'retry line\n', true));
    w.host.retarget('repo-1', 9203, 9300);
    await vi.waitFor(() => expect(w.sent).toHaveLength(1));
    expect(w.client.forgeCiJobLog).toHaveBeenLastCalledWith({ id: 'log:tab-1', repo: REPO, jobId: 9300 });
    expect(w.sent[0]).toMatchObject({ tabId: 'tab-1', view: { status: 'ready', reset: true, text: 'retry line\n' } });
    expect(w.tabs.get('tab-1')?.jobId).toBe(9300);
  });

  it('follows the newer attempt core\'s watch moved to, and no late view of the job it left', async () => {
    const w = world();
    await w.host.open('repo-1', 9203, { focus: true });
    w.host.coreLog('log:tab-1', { status: 'githubRunning', job: job(9410, 'pending'), serverName: 'github.com' });
    expect(w.tabs.get('tab-1')).toMatchObject({ jobId: 9410, state: 'pending' });
    w.host.coreLog('log:tab-1', ready(9203, 'late\n', false, 'failed'));
    expect(w.tabs.get('tab-1')).toMatchObject({ jobId: 9410, state: 'pending' });
    w.host.coreLog('log:tab-1', ready(9410, 'attempt 2\n', true));
    expect(w.sent.map((update) => update.view.status)).toEqual(['githubRunning', 'ready']);
    expect(await w.host.jobLog('tab-1')).toMatchObject({ status: 'ready', text: 'attempt 2\n', job: { id: 9410 } });
    // the tab reads the attempt it follows when it reads again
    w.client.forgeCiJobLog.mockResolvedValueOnce({ status: 'error', message: { message: 'Could not reach {0}. Check the connection and try again.', args: ['github.com'] } });
    w.host.coreAttached();
    await vi.waitFor(() => expect(w.client.forgeCiJobLog).toHaveBeenLastCalledWith({ id: 'log:tab-1', repo: REPO, jobId: 9410 }));
  });

  it('keeps only the last MAX_JOB_LOG_BYTES characters of a long log, and sends the kept tail as a reset once it cuts', async () => {
    const w = world();
    await w.host.open('repo-1', 9203, { focus: true });
    const big = 'x'.repeat(9 * 1024 * 1024);
    w.host.coreLog('log:tab-1', ready(9203, big, false));
    expect(w.sent.at(-1)?.view).toMatchObject({ reset: false, truncated: false });
    w.host.coreLog('log:tab-1', ready(9203, big, false));
    const pushed = w.sent.at(-1)!.view;
    if (pushed.status !== 'ready') throw new Error('expected ready');
    expect(pushed.reset).toBe(true);
    expect(pushed.truncated).toBe(true);
    expect(pushed.text.length).toBe(16 * 1024 * 1024);
    const whole = await w.host.jobLog('tab-1');
    if (whole.status !== 'ready') throw new Error('expected ready');
    expect(whole.text.length).toBe(16 * 1024 * 1024);
    expect(whole.truncated).toBe(true);
  });

  it('reads again on Try again after a failed first read', async () => {
    const w = world();
    w.client.forgeCiJobLog.mockResolvedValueOnce({ status: 'error', message: { message: 'Could not reach {0}. Check the connection and try again.', args: ['gitlab.com'] } });
    await w.host.open('repo-1', 9203, { focus: true });
    expect(await w.host.jobLog('tab-1')).toMatchObject({ status: 'ready', text: 'line 1\n' });
    expect(w.client.forgeCiJobLog).toHaveBeenCalledTimes(2);
  });

  it('starts each tab\'s log watch again on a new core and sends the tab its whole log', async () => {
    const w = world();
    await w.host.open('repo-1', 9203, { focus: true });
    w.host.coreLog('log:tab-1', ready(9203, 'line 2\n', false));
    w.client.forgeCiJobLog.mockResolvedValueOnce(ready(9203, 'line 1\nline 2\nline 3\n', true));
    w.host.coreAttached();
    await vi.waitFor(() => expect(w.sent).toHaveLength(2));
    expect(w.client.forgeCiJobLog).toHaveBeenCalledTimes(2);
    expect(w.sent[1]).toMatchObject({ tabId: 'tab-1', view: { status: 'ready', reset: true, text: 'line 1\nline 2\nline 3\n' } });
  });

  it('keeps the log through a later failed read, sends the failure with it, and reads it again only when asked', async () => {
    const w = world();
    await w.host.open('repo-1', 9203, { focus: true });
    w.host.coreLog('log:tab-1', ready(9203, 'line 2\n', false));
    w.host.coreLog('log:tab-1', { status: 'error', message: { message: 'Could not reach {0}. Check the connection and try again.', args: ['gitlab.com'] }, job: job(9203), serverName: 'gitlab.com' });
    expect(w.sent.at(-1)?.view).toMatchObject({ status: 'ready', reset: false, text: '', error: 'Could not reach {0}. Check the connection and try again.' });
    // a remount gets the kept log with the failure, and no read starts the log again
    expect(await w.host.jobLog('tab-1')).toMatchObject({ status: 'ready', reset: true, text: 'line 1\nline 2\n', error: 'Could not reach {0}. Check the connection and try again.' });
    expect(w.client.forgeCiJobLog).toHaveBeenCalledTimes(1);
    // Try again asks core to read the watch now; the read that works clears the failure
    await w.host.readNow('tab-1');
    expect(w.client.forgeCiJobs).toHaveBeenCalledWith('log:tab-1');
    w.host.coreLog('log:tab-1', ready(9203, 'line 3\n', false));
    expect(w.sent.at(-1)?.view).toMatchObject({ status: 'ready', reset: false, text: 'line 3\n' });
    expect(w.sent.at(-1)?.view).not.toHaveProperty('error');
    expect(await w.host.jobLog('tab-1')).not.toHaveProperty('error');
  });

  it('cuts a long log at the start of a line', async () => {
    const w = world();
    await w.host.open('repo-1', 9203, { focus: true });
    const line = `${'\u001b[31m'}${'y'.repeat(1023)}\n`;
    w.host.coreLog('log:tab-1', ready(9203, line.repeat(17 * 1024 + 2), false));
    const pushed = w.sent.at(-1)!.view;
    if (pushed.status !== 'ready') throw new Error('expected ready');
    expect(pushed.reset).toBe(true);
    expect(pushed.text.startsWith('\u001b[31my')).toBe(true);
    expect(pushed.text.length).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it('names a GitHub job by its workflow, never by a pipeline number', async () => {
    const w = world();
    const github = { ...ready(9401, 'ok\n', true), kind: 'github' as const, job: { ...job(9401), name: 'test', stage: 'CI' }, pipeline: { id: 64_312, number: 57 } };
    w.client.forgeCiJobLog.mockResolvedValueOnce(github);
    await w.host.open('repo-1', 9401, { focus: true });
    expect(w.pane.showJobLog).toHaveBeenLastCalledWith({ repoId: 'repo-1', jobId: 9401, jobName: 'test', workflow: 'CI', state: 'running' }, { focus: true });
    w.host.coreLog('log:tab-1', { ...github, reset: false, text: 'more\n', job: { ...github.job, state: 'passed' } });
    expect(w.tabs.get('tab-1')).toEqual({ repoId: 'repo-1', jobId: 9401, jobName: 'test', workflow: 'CI', state: 'passed' });
    // a job the chip does not list shows no number until its first read
    await w.host.open('repo-1', 9999, { focus: true });
    expect(w.tabs.get('tab-2')).toEqual({ repoId: 'repo-1', jobId: 9999, jobName: 'unit', pipelineNumber: 4312, state: 'running' });
    expect(w.pane.showJobLog).toHaveBeenLastCalledWith({ repoId: 'repo-1', jobId: 9999, jobName: '#9999', state: 'pending' }, { focus: true });
  });

  it('after a core restart that renamed the repository, says it is gone and ends the watch when its tab closes', async () => {
    const w = world();
    await w.host.open('repo-1', 9203, { focus: true });
    w.renameRepo('repo-1b');
    w.host.coreAttached();
    await vi.waitFor(() => expect(w.sent).toHaveLength(1));
    expect(w.sent[0]).toMatchObject({ tabId: 'tab-1', view: { status: 'error', message: 'The repository of this job is no longer open.' } });
    expect(w.client.forgeCiJobLog).toHaveBeenCalledTimes(1);
    // the editor closes a gone repository's tabs (closeChanges)
    w.close('tab-1');
    await Promise.resolve();
    expect(w.client.forgeCiUnwatch).toHaveBeenCalledWith('log:tab-1');
  });

  it('ends no log watch at dispose once the core is gone, and logs a failed end while it runs', async () => {
    const w = world();
    await w.host.open('repo-1', 9203, { focus: true });
    w.stopCore();
    w.host.dispose();
    await Promise.resolve();
    expect(w.client.forgeCiUnwatch).not.toHaveBeenCalled();
    expect(w.logs).toEqual([]);

    const running = world();
    await running.host.open('repo-1', 9203, { focus: true });
    running.client.forgeCiUnwatch.mockRejectedValueOnce(new Error('channel closed'));
    running.host.dispose();
    await vi.waitFor(() => expect(running.logs).toEqual(['[forge] ending the log watch of job 9203 failed: channel closed']));
  });
});
