import * as crypto from 'crypto';
import { log } from '../logger';
import { cronToIntervalLabel, getNextCronMatch } from '../../shared/utils/cron';
import type { LoopJob } from '../../shared/types/loop-jobs';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';

interface LoopJobTrackerOptions {
  onMessage: (message: ExtensionToWebviewMessage) => void;
}

export class LoopJobTracker {
  private jobs = new Map<string, LoopJob>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private onCronFire: ((prompt: string) => void) | null = null;
  private options: LoopJobTrackerOptions;

  constructor(options: LoopJobTrackerOptions) {
    this.options = options;
  }

  setCronFireCallback(callback: ((prompt: string) => void) | null): void {
    this.onCronFire = callback;
  }

  trackCreation(taskId: string, toolInput: Record<string, unknown>, toolResponse: string): void {
    const cron = String(toolInput['cron'] ?? '');
    const prompt = String(toolInput['prompt'] ?? toolInput['description'] ?? '');
    const recurring = Boolean(toolInput['recurring'] ?? true);

    let resolvedTaskId = taskId;
    try {
      const parsed = JSON.parse(toolResponse);
      if (parsed?.task?.id) {
        resolvedTaskId = String(parsed.task.id);
      } else if (parsed?.id) {
        resolvedTaskId = String(parsed.id);
      }
    } catch {
      const match = toolResponse.match(/job\s+(?:id[:\s]+)?([a-f0-9]+)/i);
      if (match?.[1]) {
        resolvedTaskId = match[1];
      }
    }

    if (!resolvedTaskId) return;

    const job: LoopJob = {
      taskId: resolvedTaskId,
      prompt,
      cron,
      intervalLabel: cronToIntervalLabel(cron),
      createdAt: Date.now(),
      status: 'active',
      recurring,
    };

    this.jobs.set(resolvedTaskId, job);
    log('[LoopJobTracker] Job created: id=%s, cron=%s, recurring=%s, prompt=%s', resolvedTaskId, cron, recurring, prompt.slice(0, 60));
    this.options.onMessage({ type: 'loopJobCreated', job });
  }

  createLocalJob(cron: string, prompt: string, recurring = true): string {
    const jobId = crypto.randomUUID().slice(0, 8);

    const job: LoopJob = {
      taskId: jobId,
      prompt,
      cron,
      intervalLabel: cronToIntervalLabel(cron),
      createdAt: Date.now(),
      status: 'active',
      recurring,
    };

    this.jobs.set(jobId, job);
    log('[LoopJobTracker] Local job created: id=%s, cron=%s, prompt=%s', jobId, cron, prompt.slice(0, 60));
    this.options.onMessage({ type: 'loopJobCreated', job });

    const firstMatch = getNextCronMatch(cron);
    if (firstMatch && this.onCronFire) {
      log('[LoopJobTracker] Local schedule (client-side): id=%s, firstFire=%s', jobId, firstMatch.toISOString());
      this.scheduleNextFire(jobId, cron, prompt, firstMatch);
    }

    return jobId;
  }

  handleTaskNotification(taskId: string, status: 'completed' | 'failed' | 'stopped'): boolean {
    const job = this.jobs.get(taskId);
    if (!job) return false;

    const updates: Partial<LoopJob> = {};

    if (status === 'stopped' || status === 'failed') {
      this.clearTimer(taskId);
      updates.status = 'stopped';
    } else if (status === 'completed' && job.recurring === false) {
      this.clearTimer(taskId);
      updates.status = 'stopped';
    }

    Object.assign(job, updates);
    log('[LoopJobTracker] Job updated: id=%s, status=%s', taskId, job.status);
    this.options.onMessage({ type: 'loopJobUpdated', taskId, updates });
    return true;
  }

  markCancelling(taskId: string): void {
    const job = this.jobs.get(taskId);
    if (!job) return;
    job.status = 'cancelling';
    this.clearTimer(taskId);
    this.options.onMessage({ type: 'loopJobUpdated', taskId, updates: { status: 'cancelling' } });
  }

  confirmCancelled(taskId: string): void {
    const job = this.jobs.get(taskId);
    if (!job) return;
    job.status = 'stopped';
    this.clearTimer(taskId);
    this.options.onMessage({ type: 'loopJobUpdated', taskId, updates: { status: 'stopped' } });
  }

  trackDeletion(taskId: string): void {
    if (!this.jobs.has(taskId)) return;
    this.clearTimer(taskId);
    this.jobs.delete(taskId);
    log('[LoopJobTracker] Job deleted: id=%s', taskId);
    this.options.onMessage({ type: 'loopJobRemoved', taskId });
  }

  getJobs(): LoopJob[] {
    return Array.from(this.jobs.values());
  }

  isLoopJob(taskId: string): boolean {
    return this.jobs.has(taskId);
  }

  reset(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.jobs.clear();
  }

  private scheduleNextFire(jobId: string, cron: string, prompt: string, target: Date): void {
    const delay = Math.max(1000, target.getTime() - Date.now());

    const timer = setTimeout(() => {
      this.timers.delete(jobId);

      const job = this.jobs.get(jobId);
      if (!job || job.status !== 'active') return;

      const nextMatch = getNextCronMatch(cron, target);
      if (nextMatch) {
        this.scheduleNextFire(jobId, cron, prompt, nextMatch);
      }

      log('[LoopJobTracker] Local cron fire: id=%s, prompt=%s', jobId, prompt.slice(0, 60));
      this.onCronFire?.(prompt);
    }, delay);

    this.timers.set(jobId, timer);
  }

  private clearTimer(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }
}
