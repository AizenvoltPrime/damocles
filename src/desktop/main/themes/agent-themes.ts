// Main's side of the agent's theme tools (docs/invariants.md "Desktop themes"): drawn previews and screenshots through the theme
// renderer, the keep-changes banner, a card's Show in window as the one transient preview, and the look from before an
// unsettled on-the-fly change. Every theme main gets from core is validated again before it is drawn or painted.
import { THEME_SHOW_REFUSALS, type KeepChangesState, type ThemeProposalStrip, type ThemeShowEndReason, type ThemeShowRefusal } from '../../../shared/themes/agent';
import { bundledFonts } from '../../../shared/themes/fonts';
import { validateTheme, type Arrangement, type ThemeFile, themeErrorEnglish } from '../../../shared/themes/schema';
import type { LookKind } from '../../../shared/themes/tokens';
import type { CoreRequests, Params, Result } from '../../core-protocol';
import type { ThemeHostServices } from '../core-services/host-services';
import type { HeldLook } from '../theme';
import type { TransientPreview } from './appearance';
import { KeepChanges, type KeepChangesDeps } from './keep-changes';
import type { ConfigNotices } from '../../../core/config/local-config-path';
import { readCountdownEnd, readPendingBefore } from './pending-confirm';
import { ScreenshotStore } from './screenshots';
import { pngSize, type ThemeRenderer } from './theme-renderer';

// How long a launch hold whose mark core cleared waits for main's own inputs to show the look from before.
export const LAUNCH_HOLD_WAIT_MS = 5_000;

export interface AgentThemesDeps {
  readonly root: string;
  // this app among those that share the themes folder, as a countdown's mark names it (COUNTDOWN_OWNER)
  readonly owner: string;
  // where a theme file the network rule refuses to read is told, once per file
  readonly notices?: ConfigNotices;
  readonly renderer: ThemeRenderer;
  // app://damocles/theme-shot/
  readonly shotUrlPrefix: string;
  // the window's page and the selected chat view, captured as PNGs, with the chat view's place in the window's pixels
  captureWindow(): Promise<{ readonly shell: Uint8Array; readonly chat?: { readonly png: Uint8Array; readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } } }>;
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
  // a card's Show in window took the window from the theme editor dock's preview
  editorTakenOver(): void;
  // why the window paints no preview now, or undefined once it can, told after every evaluation of the look's inputs
  editorRefused(reason: ThemeShowRefusal | undefined): void;
  // the look the window shows without a preview, which a card's Show in window takes the kind of
  shownKind(): LookKind;
  shownState(): { readonly kind: LookKind; readonly themeId: string; readonly decidedBy: string };
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
  log(line: string): void;
}

type PreviewOwner = { readonly kind: 'editor' } | { readonly kind: 'card'; readonly promptId: string; readonly chatTitle?: string };

export class AgentThemes {
  private readonly screenshots: ScreenshotStore;
  private readonly keepChanges: KeepChanges;
  private banner: KeepChangesState | undefined;
  private owner: PreviewOwner | undefined;
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
      this.deps.setPreview(undefined);
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
    const owner = this.owner;
    this.owner = undefined;
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
        this.deps.setPreview(undefined);
      }
      return refused;
    }
    this.owner = { kind: 'editor' };
    // one paint: the editor's draft replaces the card's proposal, with no look without a preview in between
    this.deps.setPreview(preview);
    if (owner?.kind !== 'card') return undefined;
    this.deps.shellChanged();
    this.tellEnded(owner.promptId, 'takenOver');
    return undefined;
  }

  /** A bundled font the renderer's current job names, which the theme-blob route serves to its page; undefined otherwise. */
  namedFontBlob(sha256: string): { readonly mime: string } | undefined {
    const theme = this.deps.renderer.currentTheme();
    const mime = theme ? bundledFonts(theme).find((font) => font.sha256 === sha256)?.mime : undefined;
    return mime !== undefined ? { mime } : undefined;
  }

  /** A screenshot a card shows; undefined once dropped or expired. */
  shot(id: string): Uint8Array | undefined {
    return this.screenshots.get(id);
  }

  /** The requests core makes for its theme tools. */
  services(): Omit<ThemeHostServices, 'themes.analyze' | 'themes.analyzeSprite'> {
    return {
      'themes.render': async ({ theme, mode }, signal) => ({ png: await this.deps.renderer.preview(this.validated(theme), mode, signal) }),
      'themes.screenshotTake': (_params, signal) => this.screenshot(signal),
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
      'themes.state': () => this.deps.shownState(),
    };
  }

  dispose(): void {
    (this.deps.timers?.clearTimer ?? clearTimeout)(this.launchTimer as ReturnType<typeof setTimeout>);
    this.keepChanges.dispose();
    this.screenshots.dispose();
  }

  private validated(theme: unknown): ThemeFile {
    const result = validateTheme(theme);
    if (!result.ok) throw new Error(`The theme is not valid: ${themeErrorEnglish(result.errors[0])}`);
    return result.theme;
  }

  // A call its caller gave up stores no screenshot, and its composite leaves the renderer's queue.
  private async screenshot(signal: AbortSignal): Promise<Result<CoreRequests, 'themes.screenshotTake'>> {
    const capture = await this.deps.captureWindow();
    signal.throwIfAborted();
    const png = capture.chat ? await this.deps.renderer.composite(capture.shell, capture.chat.png, capture.chat.bounds, signal) : capture.shell;
    const size = pngSize(png);
    if (!size) throw new Error('The window capture is not a PNG');
    const shotId = this.screenshots.put(png);
    return { shotId, url: `${this.deps.shotUrlPrefix}${shotId}`, width: size.width, height: size.height };
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
    const look = theme.looks[kind];
    if (!look) throw new Error('The theme has no look to show');
    const previous = this.owner;
    if (previous?.kind === 'card' && previous.promptId !== params.promptId) this.tellEnded(previous.promptId, 'takenOver');
    if (previous?.kind === 'editor') this.deps.editorTakenOver();
    this.owner = { kind: 'card', promptId: params.promptId, ...(params.chatTitle !== undefined ? { chatTitle: params.chatTitle } : {}) };
    this.deps.setPreview({ themeId: theme.id, kind, look, ...(theme.style ? { style: theme.style } : {}), ...(theme.assets ? { assets: theme.assets } : {}), ...(theme.css ? { css: theme.css } : {}) });
    this.deps.shellChanged();
    return {};
  }

  private endCard(): void {
    this.owner = undefined;
    this.deps.setPreview(undefined);
    this.deps.shellChanged();
  }
}
