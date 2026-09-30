import type { Page } from 'patchright';
import type { BrowserService } from './index';
import type { PageController } from './page-controller';
import type { InterceptRule, RedactedInterceptRule } from './types';
import type { ConsoleEntry, NetworkError, DownloadEntry, BrowserDialogRecord } from '../../shared/types/browser';

/** A tab as seen by ONE scope: 0-based index within the scope's own tabs. */
export interface ScopeTabInfo {
  index: number;
  title: string;
  url: string;
  active: boolean;
}

/**
 * A per-agent handle over the shared {@link BrowserService}. Created once per `buildCustomTools`
 * invocation (main agent → the primary scope, each subagent/team agent → its own id) and closed over by
 * that agent's browser-tool closures. It holds NO page state of its own — ownership lives in
 * `BrowserService` (keyed by `id`) so async popups can be attributed to the scope whose page spawned
 * them. Every method delegates to a scope-aware `BrowserService` method, so two concurrent agents each
 * drive their OWN current tab instead of a single global `activePage`.
 *
 * Context-wide resources stay shared (one Chromium context): `getDownloads` and the intercept-rule
 * methods forward straight to the service — an agent's downloads/intercepts affect the whole context.
 */
export class BrowserAgentScope {
  private readonly svc: BrowserService;
  readonly id: string;

  constructor(svc: BrowserService, id: string) {
    this.svc = svc;
    this.id = id;
  }

  getController(): PageController | null {
    return this.svc.getScopeController(this.id);
  }

  getCurrentPage(): Page | null {
    return this.svc.getScopePage(this.id);
  }

  getCurrentUrl(): string | null {
    return this.svc.getScopeCurrentUrl(this.id);
  }

  open(url: string, signal?: AbortSignal): Promise<void> {
    return this.svc.openForScope(this.id, url, signal);
  }

  waitForController(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return this.svc.waitForController(this.id, timeoutMs, signal);
  }

  listTabs(): ScopeTabInfo[] {
    return this.svc.listTabs(this.id);
  }

  selectTab(index: number): Promise<void> {
    return this.svc.selectTab(this.id, index);
  }

  closeTab(index: number): Promise<void> {
    return this.svc.closeTab(this.id, index);
  }

  openNewTab(url?: string): Promise<void> {
    return this.svc.openNewTab(this.id, url);
  }

  /** BrowserClose: close only THIS scope's tab(s); the shared context stays up while any scope holds one. */
  closeOwnTabs(): Promise<void> {
    return this.svc.closeScopeTabs(this.id);
  }

  stageUpload(paths: string[] | null): void {
    this.svc.stagePendingUpload(this.id, paths);
  }

  /** Bring this scope's current tab to the human's screencast focus. */
  reveal(): void {
    this.svc.revealScope(this.id);
  }

  getConsole(): ConsoleEntry[] {
    return this.svc.getConsoleMessages(this.id);
  }

  getNetwork(): NetworkError[] {
    return this.svc.getNetworkErrors(this.id);
  }

  /** Draining: dialogs auto-answered since the last call, so a snapshot reports each one exactly once. */
  takeUnreportedDialogs(): BrowserDialogRecord[] {
    return this.svc.takeUnreportedDialogs(this.id);
  }

  /** Non-draining: every retained dialog, for an explicit query. */
  getDialogs(): BrowserDialogRecord[] {
    return this.svc.getDialogs(this.id);
  }

  getDownloads(): DownloadEntry[] {
    return this.svc.getDownloads();
  }

  addInterceptRule(rule: Omit<InterceptRule, 'id'>): string {
    return this.svc.addInterceptRule(rule);
  }

  listInterceptRules(): RedactedInterceptRule[] {
    return this.svc.listInterceptRules();
  }

  clearInterceptRules(): void {
    this.svc.clearInterceptRules();
  }
}
