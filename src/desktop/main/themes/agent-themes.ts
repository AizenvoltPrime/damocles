// Main's side of the agent's theme tools (docs/invariants.md "Desktop themes"): drawn previews and screenshots through the theme
// renderer, the keep-changes banner, a card's Show in window as the one transient preview, and the look from before an
// unsettled on-the-fly change. Every theme main gets from core is validated again before it is drawn or painted.
import { randomUUID } from 'node:crypto';
import { THEME_RENDER_SIZE, THEME_SHOW_REFUSALS, type KeepChangesState, type RenderAppearance, type ThemeCaptureRefusal, type ThemeProposalStrip, type ThemeShowEndReason, type ThemeShowRefusal } from '../../../shared/themes/agent';
import { validateTheme, type Arrangement, type ThemeFile, themeErrorEnglish } from '../../../shared/themes/schema';
import { isBuiltinThemeId } from '../../../shared/themes/builtin';
import type { LookKind } from '../../../shared/themes/tokens';
import type { CoreRequests, Params, Result, ThemeCaptureTaken } from '../../core-protocol';
import type { ThemeHostServices } from '../core-services/host-services';
import type { HeldLook } from '../theme';
import { transientPreviewOf, type TransientPreview } from './appearance';
import type { CharacterChoiceBy } from '../../../shared/themes/characters';
import { KeepChanges, type KeepChangesDeps } from './keep-changes';
import type { ConfigNotices } from '../../../core/config/local-config-path';
import { readCountdownEnd, readPendingBefore } from './pending-confirm';
import { ScreenshotStore } from './screenshots';
import { pngSize, type RenderServed, type ThemeRenderer } from './theme-renderer';
import { characterSheetLayout } from '../../../shared/themes/character-sheet';
import type { ThemeChat, ThemeRenderAsk, ThemeRendered, ThemeShot } from '../../../shared/themes/relay';
import { sheetFacts, sheetPlan } from './character-sheets';
import type { HostColor } from '../../../shared/host-colors';
import type { ScreenshotNoticeHold } from '../../preload/shell-channels';

// How long a launch hold whose mark core cleared waits for main's own inputs to show the look from before.
export const LAUNCH_HOLD_WAIT_MS = 5_000;
// Draft captures start at least this far apart, each painting and restoring the whole window (under WCAG 2.3.1's three
// flashes a second; docs/invariants.md "Desktop themes").
export const DRAFT_CAPTURE_GAP_MS = 1_000;
// How long the notice of a capture under a chat's grant shows, counted only while nothing holds it, before it closes on its own.
export const SCREENSHOT_NOTICE_MS = 6_000;
// Past it the window capture fails, so a capture that never settles holds neither the draft nor the captures behind it.
export const WINDOW_CAPTURE_TIMEOUT_MS = 5_000;

/**
 * A capture: the chat it is for, the draft to paint for it, whether it runs under the chat's grant with no card, and the core
 * that asked (`local`, or a remote host's authority), whose grant the notice's Revoke ends.
 */
export interface CaptureAsk {
  // the chat's session id; the notice names it from this computer's own records, never from the core that asked
  readonly chat: Pick<ThemeChat, 'id'>;
  // the draft as core sent it, which main validates before it paints
  readonly theme?: unknown;
  readonly granted: boolean;
  readonly origin: string;
}

/**
 * The notice of a capture under a chat's grant while another chat shows in the window's chat slot (docs/invariants.md
 * "Desktop themes"). A newer capture of the same chat keeps its id; one of another chat takes a new id.
 */
export interface ScreenshotNoticeState {
  readonly id: string;
  // the chat's title as this computer's chat list has it, '' while it has none
  readonly chat: string;
  // the core whose chat took it: `local`, or a remote host's authority
  readonly origin: string;
  // a remote chat's host as this computer's host store names it
  readonly host?: NoticeHost;
}

export interface NoticeHost {
  readonly name: string;
  readonly color?: HostColor;
}

// What keeps the notice from closing on its own: the pointer or keyboard focus in it (the shell's word), the window unfocused
// or hidden, or an overlay popup or the theme editor dock open over the shell (main's own).
export type NoticeHold = ScreenshotNoticeHold | 'window' | 'covered';

export interface AgentThemesDeps {
  readonly root: string;
  // this app among those that share the themes folder, as a countdown's mark names it (COUNTDOWN_OWNER)
  readonly owner: string;
  // where a theme file the network rule refuses to read is told, once per file
  readonly notices?: ConfigNotices;
  readonly renderer: ThemeRenderer;
  // app://damocles/theme-shot/
  readonly shotUrlPrefix: string;
  // the window's page and the chat view on screen, captured as PNGs, with the chat view's place in the window's pixels
  captureWindow(): Promise<{ readonly shell: Uint8Array; readonly chat?: { readonly png: Uint8Array; readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } } }>;
  // the chat shown in the window's chat slot: its core (`local` or a remote host's authority) and stored session
  chatSlot(): { readonly origin: string; readonly session?: string } | undefined;
  // whether the window is there to capture: shown, covered whole by another app, minimized or hidden, or closed
  windowState(): 'shown' | 'covered' | 'hidden' | 'none';
  // the stats and flash checks of a draft's files, read before it paints (theme.ts readPreviewRecords)
  readPreviewRecords(preview: TransientPreview): Promise<void>;
  // the window's pages painted the look set last (theme-acks.ts); false once THEME_APPLIED_TIMEOUT_MS passed without
  themeApplied(signal: AbortSignal): Promise<boolean>;
  // the screenshot notice's Revoke: the grant of `chat` (a session id) ends in the core `origin` names, or in RelayedConsents
  revokeGrant(origin: string, chat: string): Promise<void>;
  // the notice's names for the chat of `session` on `origin`: its title from main's own chat list, and a remote chat's host
  noticeNames(origin: string, session: string): { readonly chat: string; readonly host?: NoticeHost };
  // the notice closed while keyboard focus was in it: focus goes back to where it was before
  noticeFocusLeft(): void;
  // core's requests: the banner's Keep, its revert of exactly one entry (whether core undid it, and the window arrangement the
  // change replaced), the end of a card's Show in window, and a screenshot that left while its card may still show it
  readonly core: {
    keep(entryId: string): Promise<void>;
    revert(entryId: string): Promise<{ readonly reverted: boolean; readonly arrangement?: unknown }>;
    showEnded(promptId: string, reason: ThemeShowEndReason): Promise<void>;
    screenshotGone(shotId: string): Promise<void>;
  };
  // the window's transient preview, which one owner holds at a time
  setPreview(preview: TransientPreview | undefined): void;
  // the theme an open card of the stage draws, whose blobs the chat page may load; undefined once it closed
  cardTheme(stageId: string, theme: ThemeFile | undefined): void;
  // a card's Show in window took the window from the theme editor dock's preview
  editorTakenOver(): void;
  // why the window paints no preview now, or undefined once it can, told after every evaluation of the look's inputs
  editorRefused(reason: ThemeShowRefusal | undefined): void;
  // the look the window shows without a preview, which a card's Show in window and a drawn preview take the kind of
  shownKind(): LookKind;
  // the drawn preview's appearance of a theme's look (theme.ts renderAppearance) in the window's arrangement
  renderAppearance(theme: ThemeFile, kind: LookKind): Promise<{ readonly appearance: RenderAppearance; readonly served: RenderServed }>;
  shownState(): { readonly kind: LookKind; readonly themeId: string; readonly decidedBy: string };
  // the character the project of `key` shows as if it were selected (theme.ts projectCharacter)
  projectCharacter(key: string): { readonly themeId: string; readonly character: string; readonly by: CharacterChoiceBy } | undefined;
  setHeldLook(next: { readonly look: HeldLook; readonly scope: 'window' | 'trusted' } | undefined): void;
  // the live inputs resolve to the held look: core's revert reached every input main reads on its own
  heldLookSettled(): boolean;
  // the window's arrangement now, and one put in place as a manual pick puts it (pickTheme), checked again first
  currentArrangement(): Arrangement;
  applyArrangement(arrangement: unknown, density?: number): void;
  // ShellState's banner and strip changed
  shellChanged(): void;
  // the countdown stopped counting, told before the shell hears it: the banner's buttons are about to go
  countdownEnded(): void;
  // the countdown's clock and timers; a desktop end-to-end run passes ones it fires itself (held-timers.ts)
  readonly timers?: Pick<KeepChangesDeps, 'now' | 'setTimer' | 'clearTimer'>;
  // the screenshot notice's timer, which a desktop end-to-end run also passes, and each notice raised, which it records
  readonly noticeTimers?: Pick<KeepChangesDeps, 'setTimer' | 'clearTimer'>;
  noticeRaised?(notice: ScreenshotNoticeState): void;
  log(line: string): void;
}

// The notice showing; `remaining` counts down only while `timer` runs, from `started`.
interface LiveNotice {
  id: string;
  readonly session: string;
  readonly origin: string;
  readonly names: ReturnType<AgentThemesDeps['noticeNames']>;
  remaining: number;
  started?: number | undefined;
  timer?: unknown;
}

type PreviewOwner = { readonly kind: 'editor' } | { readonly kind: 'card'; readonly promptId: string; readonly chatTitle?: string };

/** Why a running capture was stopped from here: the window closed, or the core that asked ended. */
export class CaptureStopped extends Error {
  readonly stop: 'noWindow' | 'coreEnded';

  constructor(stop: 'noWindow' | 'coreEnded') {
    super(stop === 'noWindow' ? 'The window closed during the screenshot' : "This computer's Damocles engine ended during the screenshot");
    this.name = 'CaptureStopped';
    this.stop = stop;
  }
}

// Settles as `work` does, or rejects once `signal` aborts or `timeoutMs` passes; work that settles after that is ignored.
function bounded<T>(work: Promise<T>, signal: AbortSignal, timeoutMs?: number, timeoutMessage?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const end = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
    };
    const aborted = (): void => {
      end();
      reject(signal.reason as Error);
    };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      end();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    signal.addEventListener('abort', aborted, { once: true });
    work.then((value) => {
      end();
      resolve(value);
    }, (err: unknown) => {
      end();
      reject(err as Error);
    });
  });
}

export class AgentThemes {
  private readonly screenshots: ScreenshotStore;
  private readonly keepChanges: KeepChanges;
  private banner: KeepChangesState | undefined;
  private owner: PreviewOwner | undefined;
  // the owner's transient preview, and a draft painted over it for a capture alone; the window paints capture ?? ownerPreview
  private ownerPreview: TransientPreview | undefined;
  private capture: TransientPreview | undefined;
  // captures run one at a time, in the order they were asked
  private captures: Promise<void> = Promise.resolve();
  // when the last draft capture started (DRAFT_CAPTURE_GAP_MS)
  private lastDraftStart: number | undefined;
  private running: { readonly stop: AbortController; readonly origin: string } | undefined;
  private notice: LiveNotice | undefined;
  private readonly noticeHolds = new Set<NoticeHold>();
  private launchHold = false;
  // the entry the launch's mark named
  private launchEntry: string | undefined;
  // core's revert cleared the mark; the hold ends once main's inputs show the look from before, or LAUNCH_HOLD_WAIT_MS later
  private markGone = false;
  private launchTimer: unknown;
  // counts the reads of the look from before, so an older read that lands late never replaces a newer one's hold
  private holdReads = 0;
  // The arrangement beforeFirstPaint replaced with the one from before the mark it found. Core's word of the same revert
  // does not apply that one again, and a change that stays takes this one back.
  private launchReplaced: Arrangement | undefined;
  private readonly deps: AgentThemesDeps;

  constructor(deps: AgentThemesDeps) {
    this.deps = deps;
    this.screenshots = new ScreenshotStore({
      evicted: (shotId) => {
        deps.core.screenshotGone(shotId).catch((err: unknown) => deps.log(`[themes] the card of a screenshot that left to make room was not told: ${err instanceof Error ? err.message : String(err)}`));
      },
    });
    this.keepChanges = new KeepChanges({
      keep: (entryId) => deps.core.keep(entryId),
      // core has undone the change by now, so the answer never depends on the arrangement main puts back after it
      revert: async (entryId) => {
        const { reverted, arrangement } = await deps.core.revert(entryId);
        if (arrangement !== undefined) this.putBack(arrangement);
        return reverted;
      },
      publish: (state) => {
        const counted = this.banner?.phase === 'counting';
        this.banner = state;
        if (counted && state?.phase !== 'counting') deps.countdownEnded();
        deps.shellChanged();
        if (state?.phase !== 'counting') deps.setHeldLook(undefined);
      },
      ...deps.timers,
      log: deps.log,
    });
  }

  /**
   * Before the first paint: a mark a crash or force-quit of this app left paints the look from before its change until core
   * reverts it. A mark that names only other apps is a countdown of theirs, which this window neither holds nor rearranges.
   */
  async beforeFirstPaint(): Promise<void> {
    const pending = await readPendingBefore(this.deps.root, this.deps.log, this.deps.notices);
    if (!pending?.mark.owners.includes(this.deps.owner)) return;
    this.deps.log('[themes] the last run ended during the keep-changes countdown; the look from before the change shows');
    this.launchHold = true;
    this.launchEntry = pending.mark.entryId;
    this.deps.setHeldLook({ look: pending.look, scope: 'window' });
    // core reverts the files at its start; the window arrangement is main's, so main puts the one from before back itself
    if (pending.arrangement === undefined) return;
    const replaced = this.deps.currentArrangement();
    if (this.putBack(pending.arrangement)) this.launchReplaced = replaced;
  }

  // The window arrangement a reverted change replaced; one that no longer parses is logged and the window stays as it is.
  private putBack(arrangement: unknown): boolean {
    try {
      this.deps.applyArrangement(arrangement);
      return true;
    } catch (err) {
      this.deps.log(`[themes] the window arrangement from before the reverted change was not put back: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // The change the launch found stays on disk, kept or still counted by another running app: the look from before is no
  // look to wait for, and the window takes back the arrangement the launch replaced, the change's own.
  private launchChangeStays(entryId: string): void {
    if (!this.launchHold || entryId !== this.launchEntry) return;
    const replaced = this.launchReplaced;
    this.releaseLaunchHold();
    if (replaced === undefined) return;
    try {
      this.deps.applyArrangement(replaced);
    } catch (err) {
      this.deps.log(`[themes] the window arrangement of the change that stays was not put back: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A throw and a rejection of the wiring both end in the log, so no caller's own work stops at a card that was not told.
  private tellEnded(promptId: string, reason: ThemeShowEndReason): void {
    const failed = (err: unknown): void => this.deps.log(`[themes] the card was not told its preview ended: ${err instanceof Error ? err.message : String(err)}`);
    try {
      this.deps.core.showEnded(promptId, reason).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  /**
   * After core changed the theme files and main read them. Once core's revert cleared the mark, a launch hold ends when the
   * inputs main reads on its own show the look from before too, so the window never paints the unsettled one in between.
   */
  async themesChanged(): Promise<void> {
    if (!this.launchHold || this.markGone) return;
    const pending = await readPendingBefore(this.deps.root, this.deps.log, this.deps.notices);
    if (pending || !this.launchHold || this.markGone) return;
    this.markGone = true;
    // a revert that failed, or a change the user made meanwhile, never shows the held look again
    this.launchTimer = (this.deps.timers?.setTimer ?? setTimeout)(() => this.releaseLaunchHold(), LAUNCH_HOLD_WAIT_MS);
    this.inputsChanged();
  }

  /** After every evaluation of the look's inputs: the settings, the theme files, the schedule, the project looks, the OS. */
  inputsChanged(): void {
    if (this.launchHold && this.markGone && this.deps.heldLookSettled()) this.releaseLaunchHold();
    const owner = this.owner;
    const refused = this.showRefusal();
    this.deps.editorRefused(refused);
    if (refused === undefined) return;
    if (owner?.kind === 'editor') {
      this.owner = undefined;
      this.setOwnerPreview(undefined);
    }
    if (owner?.kind !== 'card') return;
    this.endCard();
    this.tellEnded(owner.promptId, refused);
  }

  private releaseLaunchHold(): void {
    if (!this.launchHold) return;
    (this.deps.timers?.clearTimer ?? clearTimeout)(this.launchTimer as ReturnType<typeof setTimeout>);
    this.launchTimer = undefined;
    this.launchHold = false;
    this.launchEntry = undefined;
    this.markGone = false;
    this.launchReplaced = undefined;
    if (!this.keepChanges.counting()) this.deps.setHeldLook(undefined);
  }

  // Forced colors and safe start pick the look before any preview, so a card's proposal or the editor's draft would not paint.
  private showRefusal(): ThemeShowRefusal | undefined {
    const { decidedBy } = this.deps.shownState();
    return THEME_SHOW_REFUSALS.find((reason) => reason === decidedBy);
  }

  /**
   * This computer's engine ended. Nothing can settle the countdown until one starts, so it stops; and every card's stage went
   * with the engine, so a card's Show in window ends.
   */
  coreEnded(): void {
    if (this.running?.origin === 'local') this.running.stop.abort(new CaptureStopped('coreEnded'));
    this.keepChanges.coreEnded();
    const owner = this.owner;
    if (owner?.kind !== 'card') return;
    this.endCard();
    // a remote chat's card lives in its own core, which still runs and hears it
    this.tellEnded(owner.promptId, 'stopped');
  }

  /** An engine started: the countdown the ended one left counts again while its mark stands, else it ended as the files say. */
  async coreStarted(): Promise<void> {
    const entryId = this.keepChanges.entryId();
    const stands = entryId === undefined ? 'kept' : await readCountdownEnd(this.deps.root, entryId, this.deps.log, this.deps.notices);
    // A countdown that ended or changed while the files were read is not this one. Files main cannot read name no end, so
    // the countdown stands until core's own word ends it: its revert at its start, or its answer to the countdown's end.
    this.keepChanges.coreStarted(this.keepChanges.entryId() === entryId && stands !== 'unknown' ? stands : 'marked');
  }

  keepState(): KeepChangesState | undefined {
    return this.banner;
  }

  proposalStrip(): ThemeProposalStrip | undefined {
    const owner = this.owner;
    return owner?.kind === 'card' ? { promptId: owner.promptId, ...(owner.chatTitle !== undefined ? { chatTitle: owner.chatTitle } : {}) } : undefined;
  }

  counting(): boolean {
    return this.keepChanges.counting();
  }

  keep(): Promise<void> {
    return this.keepChanges.keep();
  }

  revert(): Promise<void> {
    return this.keepChanges.revert();
  }

  /** The strip's Stop showing. */
  async stopShowing(): Promise<void> {
    const owner = this.owner;
    if (owner?.kind !== 'card') return;
    this.endCard();
    await this.deps.core.showEnded(owner.promptId, 'stopped');
  }

  /** The window closed: its transient preview ends, and a card showing in it hears it stopped. */
  windowClosed(): void {
    this.running?.stop.abort(new CaptureStopped('noWindow'));
    const owner = this.owner;
    this.owner = undefined;
    // main ends the window's preview itself; a capture that ends after this paints none
    this.ownerPreview = undefined;
    if (owner?.kind !== 'card') return;
    this.tellEnded(owner.promptId, 'stopped');
  }

  /**
   * The theme editor's live preview, the newest transient preview: a card's Show in window ends with a note. Answers why the
   * window paints no preview now, in which case none is set and a card's stays as it is.
   */
  editorPreview(preview: TransientPreview | undefined): ThemeShowRefusal | undefined {
    const owner = this.owner;
    const refused = this.showRefusal();
    if (preview === undefined || refused !== undefined) {
      if (owner?.kind === 'editor') {
        this.owner = undefined;
        this.setOwnerPreview(undefined);
      }
      return refused;
    }
    this.owner = { kind: 'editor' };
    // one paint: the editor's draft replaces the card's proposal, with no look without a preview in between
    this.setOwnerPreview(preview);
    if (owner?.kind !== 'card') return undefined;
    this.deps.shellChanged();
    this.tellEnded(owner.promptId, 'takenOver');
    return undefined;
  }

  /** A screenshot a card shows; undefined once dropped or expired. */
  shot(id: string): Uint8Array | undefined {
    return this.screenshots.get(id);
  }

  /** The requests core makes for its theme tools. */
  services(): Omit<ThemeHostServices, 'themes.analyze' | 'themes.analyzeSprite' | 'themes.copyName'> {
    return {
      'themes.render': ({ theme, ...ask }, signal) => this.render(this.validated(theme, true), ask, signal),
      'themes.screenshotTake': ({ chat, theme, granted }, signal) => this.take({ chat, ...(theme !== undefined ? { theme } : {}), granted: granted === true, origin: 'local' }, signal),
      'themes.screenshotRead': ({ shotId }) => {
        const png = this.screenshots.get(shotId);
        if (!png) throw new Error('The screenshot is gone: its card closed, it waited too long, or newer screenshots took its place');
        return { png };
      },
      'themes.screenshotDrop': ({ shotId }) => this.screenshots.drop(shotId),
      'themes.applied': (params, signal) => this.applied(params, signal),
      'themes.pendingSettled': ({ entryId, outcome, arrangement, atStart }) => this.pendingSettled(entryId, outcome, arrangement, atStart === true),
      'themes.pendingElsewhere': ({ entryId }) => this.launchChangeStays(entryId),
      'themes.pendingExtended': (params) => this.extended(params),
      'themes.currentArrangement': () => ({ arrangement: this.deps.currentArrangement() }),
      'themes.applyArrangement': ({ arrangement, density }) => this.deps.applyArrangement(arrangement, density),
      'themes.showInWindow': (params) => this.showInWindow(params),
      'themes.stopShowing': ({ promptId }) => {
        if (this.owner?.kind === 'card' && this.owner.promptId === promptId) this.endCard();
      },
      'themes.cardOpened': ({ stageId, theme }) => this.deps.cardTheme(stageId, this.validated(theme)),
      'themes.cardClosed': ({ stageId }) => this.deps.cardTheme(stageId, undefined),
      'themes.state': () => this.deps.shownState(),
      'themes.projectCharacter': ({ key }) => {
        const shown = this.deps.projectCharacter(key);
        return shown ? { character: { themeId: shown.themeId, name: shown.character, by: shown.by } } : {};
      },
    };
  }

  /** The notice of a capture under a chat's grant; undefined while none shows. */
  screenshotNotice(): ScreenshotNoticeState | undefined {
    const notice = this.notice;
    return notice ? { id: notice.id, chat: notice.names.chat, origin: notice.origin, ...(notice.names.host ? { host: notice.names.host } : {}) } : undefined;
  }

  /** The notice's Dismiss: it closes, for the notice of that id only. */
  dismissNotice(id: string): void {
    if (this.notice?.id === id) this.closeNotice(true);
  }

  /** The notice's Revoke: its chat's grant ends in the core or the record that holds it, and then it closes; a failed revoke leaves it. */
  async revokeNotice(id: string): Promise<void> {
    const notice = this.notice;
    if (notice?.id !== id) return;
    await this.deps.revokeGrant(notice.origin, notice.session);
    if (this.notice?.id === id) this.closeNotice(true);
  }

  /**
   * The shell's pointer or keyboard focus entered or left the notice of `id`. A release counts whatever id it names, since the
   * notice it left may have been replaced in place meanwhile.
   */
  holdNotice(id: string, reason: ScreenshotNoticeHold, held: boolean): void {
    if (held && this.notice?.id !== id) return;
    this.setNoticeHold(reason, held);
  }

  /** Main's own reasons the notice may be unseen: the window unfocused or hidden, or a view over the shell. */
  setNoticeHold(reason: NoticeHold, held: boolean): void {
    if (held === this.noticeHolds.has(reason)) return;
    if (held) this.noticeHolds.add(reason);
    else this.noticeHolds.delete(reason);
    this.runNoticeClock();
  }

  /**
   * A screenshot for `ask.chat`: of the window as it is, or with `ask.theme` of the window painted with that draft for the
   * capture alone (captureDraft). Captures run one at a time. A refusal takes nothing; a caller that gave up keeps nothing.
   */
  take(ask: CaptureAsk, signal: AbortSignal): Promise<ThemeCaptureTaken> {
    const ahead = this.captures;
    // a caller that gives up while queued hears so at once
    const run = bounded(ahead, signal).then(() => this.takeNow(ask, signal));
    // the next capture waits for every one ahead of it and for this one, however each ends
    this.captures = Promise.allSettled([ahead, run]).then(() => undefined);
    return run;
  }

  dispose(): void {
    this.closeNotice(false);
    (this.deps.timers?.clearTimer ?? clearTimeout)(this.launchTimer as ReturnType<typeof setTimeout>);
    this.keepChanges.dispose();
    this.screenshots.dispose();
  }

  // `builtins`: a drawn preview, which may be of a built-in theme under its own id; a card, a capture and Show in window never are
  validated(theme: unknown, builtins = false): ThemeFile {
    const id = typeof theme === 'object' && theme !== null ? (theme as { readonly id?: unknown }).id : undefined;
    const result = validateTheme(theme, builtins && typeof id === 'string' && isBuiltinThemeId(id) ? { builtin: true } : {});
    if (!result.ok) throw new Error(`The theme is not valid: ${themeErrorEnglish(result.errors[0])}`);
    return result.theme;
  }

  // The look drawn is the one asked for, else the kind on screen when the theme has it, else the theme's only look. A sheet's
  // pages are each sized by its layout.
  private async render(theme: ThemeFile, { view, look, characters }: ThemeRenderAsk, signal: AbortSignal): Promise<ThemeRendered> {
    if (look !== undefined && !theme.looks[look]) throw new Error(`The theme has no ${look} look`);
    const shownKind = this.deps.shownKind();
    const kind: LookKind = look ?? (theme.looks[shownKind] ? shownKind : theme.looks.dark ? 'dark' : 'light');
    const { appearance, served } = await this.deps.renderAppearance(theme, kind);
    signal.throwIfAborted();
    if (view !== 'characters') return { pngs: [await this.deps.renderer.window({ kind: 'window', view, appearance, ...THEME_RENDER_SIZE }, served, signal)] };
    const plan = sheetPlan(theme, appearance, characters);
    const layout = characterSheetLayout(plan.inputs, { wallpaper: plan.wallpaper, sidebarAvatar: plan.sidebarAvatar });
    const pngs = await this.deps.renderer.characterSheets(appearance, layout, plan.views, served, signal);
    return { pngs, sheet: sheetFacts(plan, layout) };
  }

  private async takeNow(ask: CaptureAsk, signal: AbortSignal): Promise<ThemeCaptureTaken> {
    signal.throwIfAborted();
    const unseen = this.captureRefusal(ask.theme !== undefined);
    if (unseen !== undefined) return { kind: 'refused', reason: unseen };
    if (ask.theme === undefined) {
      const shot = await this.store(await this.windowPixels(signal), signal);
      if (ask.granted && this.offSlot(ask)) this.raiseNotice(ask);
      return { kind: 'shot', shot };
    }
    return this.captureDraft(ask, this.validated(ask.theme), signal);
  }

  // Why no capture can run now: the window is gone or not on screen, or for a draft, forced colors or safe start pick the look.
  private captureRefusal(draft: boolean): ThemeCaptureRefusal | undefined {
    const window = this.deps.windowState();
    if (window === 'none') return 'noWindow';
    if (window === 'hidden') return 'windowHidden';
    // a covered window's pages draw no frame, so they would never acknowledge a draft
    if (window === 'covered') return 'covered';
    return draft ? this.showRefusal() : undefined;
  }

  // A capture under the grant is for a chat the window's chat slot does not show, which the notice then explains.
  private offSlot(ask: CaptureAsk): boolean {
    const slot = this.deps.chatSlot();
    return slot?.origin !== ask.origin || slot.session !== ask.chat.id;
  }

  // Paints the draft over whatever the window shows, waits until its pages painted it, takes the window's pixels, and paints the
  // owner's look again before the composite and on every end. It is no owner: no card hears takenOver or showEnded, and an owner
  // change meanwhile shows after it. It runs, and windowClosed and coreEnded stop it, until its composite settles.
  private async captureDraft(ask: CaptureAsk, theme: ThemeFile, signal: AbortSignal): Promise<ThemeCaptureTaken> {
    await this.untilGap(signal);
    const later = this.captureRefusal(true);
    if (later !== undefined) return { kind: 'refused', reason: later };
    const shownKind = this.deps.shownKind();
    const preview = transientPreviewOf(theme, theme.looks[shownKind] ? shownKind : theme.looks.dark ? 'dark' : 'light');
    if (!preview) throw new Error('The theme has no look to capture');
    const stop = new AbortController();
    this.running = { stop, origin: ask.origin };
    const both = AbortSignal.any([signal, stop.signal]);
    try {
      await bounded(this.deps.readPreviewRecords(preview), both);
      // every repaint the user did not watch is explained, however the capture ends
      if (ask.granted && this.offSlot(ask)) this.raiseNotice(ask);
      this.lastDraftStart = Date.now();
      this.capture = preview;
      this.paint();
      if (!(await this.deps.themeApplied(both))) return { kind: 'refused', reason: this.captureRefusal(true) ?? 'timeout' };
      // forced colors or safe start that began meanwhile paint the built-in look over the draft
      const refused = this.captureRefusal(true);
      if (refused !== undefined) return { kind: 'refused', reason: refused };
      const pixels = await this.windowPixels(both);
      this.capture = undefined;
      this.paint();
      return { kind: 'shot', shot: await this.store(pixels, both) };
    } catch (err) {
      const stopped = stop.signal.reason;
      if (!signal.aborted && stopped instanceof CaptureStopped && stopped.stop === 'noWindow') return { kind: 'refused', reason: 'noWindow' };
      throw err;
    } finally {
      this.running = undefined;
      this.capture = undefined;
      this.paint();
    }
  }

  // Resolves DRAFT_CAPTURE_GAP_MS after the last draft capture started.
  private async untilGap(signal: AbortSignal): Promise<void> {
    const wait = this.lastDraftStart === undefined ? 0 : this.lastDraftStart + DRAFT_CAPTURE_GAP_MS - Date.now();
    if (wait <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const aborted = (): void => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', aborted);
        resolve();
      }, wait);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  // The window's pixels, the shell's and then the chat view's, within WINDOW_CAPTURE_TIMEOUT_MS.
  private windowPixels(signal: AbortSignal): ReturnType<AgentThemesDeps['captureWindow']> {
    return bounded(this.deps.captureWindow(), signal, WINDOW_CAPTURE_TIMEOUT_MS, `The window capture did not finish within ${WINDOW_CAPTURE_TIMEOUT_MS / 1000} s`);
  }

  // The chat view composited over the shell and stored. A call its caller gave up stores no screenshot, and its composite
  // leaves the renderer's queue.
  private async store(capture: Awaited<ReturnType<AgentThemesDeps['captureWindow']>>, signal: AbortSignal): Promise<ThemeShot> {
    const png = capture.chat ? await this.deps.renderer.composite(capture.shell, capture.chat.png, capture.chat.bounds, signal) : capture.shell;
    signal.throwIfAborted();
    const size = pngSize(png);
    if (!size) throw new Error('The window capture is not a PNG');
    const shotId = this.screenshots.put(png);
    return { shotId, url: `${this.deps.shotUrlPrefix}${shotId}`, width: size.width, height: size.height };
  }

  // A newer capture's notice replaces the one showing in place, keeping its id for the same chat and taking a new one for
  // another, and its SCREENSHOT_NOTICE_MS start again.
  private raiseNotice(ask: CaptureAsk): void {
    const names = this.deps.noticeNames(ask.origin, ask.chat.id);
    const current = this.notice;
    if (current) this.pauseNotice(current);
    const same = current !== undefined && current.origin === ask.origin && current.session === ask.chat.id;
    this.notice = { id: same ? current.id : randomUUID(), session: ask.chat.id, origin: ask.origin, names, remaining: SCREENSHOT_NOTICE_MS };
    this.runNoticeClock();
    this.deps.shellChanged();
    this.deps.noticeRaised?.(this.screenshotNotice()!);
  }

  // The notice's timer runs only while nothing holds it, for the time it has left.
  private runNoticeClock(): void {
    const notice = this.notice;
    if (!notice) return;
    if (this.noticeHolds.size > 0) {
      this.pauseNotice(notice);
      return;
    }
    if (notice.timer !== undefined) return;
    notice.started = Date.now();
    notice.timer = (this.deps.noticeTimers?.setTimer ?? setTimeout)(() => this.closeNotice(true), notice.remaining);
  }

  private pauseNotice(notice: LiveNotice): void {
    if (notice.timer === undefined) return;
    (this.deps.noticeTimers?.clearTimer ?? clearTimeout)(notice.timer as ReturnType<typeof setTimeout>);
    notice.remaining = Math.max(0, notice.remaining - (Date.now() - (notice.started ?? Date.now())));
    notice.timer = undefined;
    notice.started = undefined;
  }

  // `returnFocus`: keyboard focus in the notice goes back where it came from; false only as main disposes of it.
  private closeNotice(returnFocus: boolean): void {
    const notice = this.notice;
    if (!notice) return;
    this.pauseNotice(notice);
    this.notice = undefined;
    const focused = this.noticeHolds.has('focus');
    // the shell's holds were on the notice's element, which goes with it
    this.noticeHolds.delete('pointer');
    this.noticeHolds.delete('focus');
    this.deps.shellChanged();
    if (returnFocus && focused) this.deps.noticeFocusLeft();
  }

  private setOwnerPreview(preview: TransientPreview | undefined): void {
    this.ownerPreview = preview;
    this.paint();
  }

  private paint(): void {
    this.deps.setPreview(this.capture ?? this.ownerPreview);
  }

  // Core's messages are handled in the order they arrive only up to a handler's first await, so the countdown changes
  // before anything is read; the look from before is read after it and held only for the countdown still running.
  private async applied(params: Params<CoreRequests, 'themes.applied'>, signal: AbortSignal): Promise<Result<CoreRequests, 'themes.applied'>> {
    const waiting = this.keepChanges.applied({
      entryId: params.entryId,
      ...(params.chatId !== undefined ? { chatId: params.chatId } : {}),
      ...(params.chatTitle !== undefined ? { chatTitle: params.chatTitle } : {}),
      change: params.change,
      ...(params.previousName !== undefined ? { previousName: params.previousName } : {}),
      ...(params.previousId !== undefined ? { previousId: params.previousId } : {}),
    }, signal);
    const [outcome] = await Promise.all([waiting, this.holdBefore(params.entryId)]);
    return { outcome };
  }

  // Trusted UI keeps the look from before the countdown's first change, read again as the countdown covers more.
  private async holdBefore(entryId: string): Promise<void> {
    const read = ++this.holdReads;
    const pending = await readPendingBefore(this.deps.root, this.deps.log, this.deps.notices);
    if (read !== this.holdReads || pending?.mark.entryId !== entryId || this.keepChanges.entryId() !== entryId) return;
    this.deps.setHeldLook({ look: pending.look, scope: 'trusted' });
  }

  // Core ended a countdown itself: at its start, or for the user's Undo of the countdown's first change (reverted), or for a
  // mark whose entry left the history (kept). With an arrangement it reverted the changes at its start, and the window
  // arrangement they replaced is main's to put back, once: a launch that found the mark already did, and the user may have
  // moved a pane since.
  private pendingSettled(entryId: string, outcome: 'kept' | 'reverted', arrangement: unknown, atStart: boolean): void {
    this.keepChanges.settled(entryId, outcome, atStart ? 'engineStart' : outcome === 'reverted' ? 'user' : undefined);
    // core kept the change it could not revert
    if (outcome === 'kept') this.launchChangeStays(entryId);
    if (arrangement === undefined) return;
    if (this.launchReplaced !== undefined) this.launchReplaced = undefined;
    else this.putBack(arrangement);
  }

  private async extended(params: Params<CoreRequests, 'themes.pendingExtended'>): Promise<void> {
    this.keepChanges.extended({
      entryId: params.entryId,
      ...(params.chatId !== undefined ? { chatId: params.chatId } : {}),
      ...(params.chatTitle !== undefined ? { chatTitle: params.chatTitle } : {}),
      change: params.change,
    });
    await this.holdBefore(params.entryId);
  }

  private showInWindow(params: Params<CoreRequests, 'themes.showInWindow'>): Result<CoreRequests, 'themes.showInWindow'> {
    const theme = this.validated(params.theme);
    const refused = this.showRefusal();
    if (refused !== undefined) return { refused };
    const shownKind = this.deps.shownKind();
    const kind: LookKind = theme.looks[shownKind] ? shownKind : theme.looks.dark ? 'dark' : 'light';
    const preview = transientPreviewOf(theme, kind);
    if (!preview) throw new Error('The theme has no look to show');
    const previous = this.owner;
    if (previous?.kind === 'card' && previous.promptId !== params.promptId) this.tellEnded(previous.promptId, 'takenOver');
    if (previous?.kind === 'editor') this.deps.editorTakenOver();
    this.owner = { kind: 'card', promptId: params.promptId, ...(params.chatTitle !== undefined ? { chatTitle: params.chatTitle } : {}) };
    this.setOwnerPreview(preview);
    this.deps.shellChanged();
    return {};
  }

  private endCard(): void {
    this.owner = undefined;
    this.setOwnerPreview(undefined);
    this.deps.shellChanged();
  }
}
