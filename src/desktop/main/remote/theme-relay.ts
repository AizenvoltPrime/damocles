// A remote chat's theme tools change this computer's app (docs/invariants.md "Remote daemon and wire", user.theme): main
// refuses while the tools are off here, counts as the user's consent only a press it saw its own page post on a card it
// filled from its own record, logs, and forwards to this computer's core, which alone writes the theme files and bounds its answers.
import {
  boundedRelayText, CLIENT_THEMES_OFF, MAX_COMPUTER_NAME_CHARS, MAX_RELAYED_THEME_PNG_BYTES, MAX_THEME_UPLOAD_BYTES, THEME_UPLOAD_CHUNK_BYTES, THEMES_FEATURE,
  type RelayedThemeProject, type ThemeShot, type ThemeShowEnded, type ThemeStagedCard, type UserThemeCalls, type UserThemeMethod,
} from '../../../shared/themes/relay';
import { THEME_SHOW_NOTES } from '../../../shared/themes/agent';
import type { ThemeInstallClashChoice, ThemeInstallPreview, ThemeInstallProgress } from '../../../shared/themes/install';
import type { MainRequests } from '../../core-protocol/messages';
import { l } from '../../../core/l10n';

type CoreThemeRelay = {
  readonly [M in Extract<keyof MainRequests, `themes.relay.${string}`>]: (params: MainRequests[M]['params'], signal: AbortSignal) => Promise<MainRequests[M]['result']>;
};

export interface ThemeRelayDeps {
  readonly authority: string;
  // damocles.desktop.themes.agentTools on this computer
  readonly enabled: () => boolean;
  // this computer's name, which another device's card names as the one that changes
  readonly computer: () => string;
  // the host project holding the chat's folder on this computer; undefined for a folder of none
  readonly project: (folder: string) => RelayedThemeProject | undefined;
  readonly core: CoreThemeRelay;
  readonly screenshots: {
    take(signal: AbortSignal): Promise<ThemeShot>;
    read(shotId: string, signal: AbortSignal): Promise<Uint8Array>;
    drop(shotId: string): Promise<void>;
  };
  // tells this authority's core that the window let go of a screenshot its card may still show
  readonly shotGone: (shotId: string) => Promise<void>;
  readonly previews: RelayedPreviews;
  readonly installs: RelayedInstalls;
  readonly consents: RelayedConsents;
  readonly log: (line: string) => void;
}

export interface RelayedInstallsDeps {
  // the daemon's welcome features; undefined while the host is not connected
  readonly features: (authority: string) => readonly string[] | undefined;
  readonly sendUpdated: (authority: string, preview: ThemeInstallPreview) => Promise<void>;
  readonly sendProgress: (authority: string, progress: ThemeInstallProgress) => Promise<void>;
  readonly sendExpired: (authority: string, installId: string) => Promise<void>;
  readonly log: (line: string) => void;
}

// A bound only: core stages at most MAX_STAGED_INSTALLS installs at once, and commit or cancel removes the entry.
const MAX_RELAYED_INSTALLS = 16;

/** The installs this computer's core staged for a remote chat, by install id, so their updates reach the core that asked. */
export class RelayedInstalls {
  private readonly staged = new Map<string, string>();
  // Expiries a host could not take, install id to authority, sent when the host connects: its ThemeSet's card ends on that
  // word alone.
  private readonly missedExpiries = new Map<string, string>();
  // installs whose host could not take a send, logged once until a send reaches it again: progress ticks every 500 ms
  private readonly unsent = new Set<string>();
  private readonly deps: RelayedInstallsDeps;

  constructor(deps: RelayedInstallsDeps) {
    this.deps = deps;
  }

  add(installId: string, authority: string): void {
    this.drop(installId);
    this.staged.set(installId, authority);
    for (const old of [...this.staged.keys()].slice(0, Math.max(0, this.staged.size - MAX_RELAYED_INSTALLS))) this.drop(old);
  }

  /** The install ended for the authority that staged it; another authority's word ends nothing. */
  ended(installId: string, authority: string): void {
    if (this.staged.get(installId) === authority) this.drop(installId);
  }

  forgetAuthority(authority: string): void {
    for (const [installId, owner] of [...this.staged]) if (owner === authority) this.drop(installId);
    for (const [installId, owner] of [...this.missedExpiries]) if (owner === authority) this.missedExpiries.delete(installId);
  }

  /** The authority's core is attached: the expiries it missed are sent now, and one that fails again waits for the next. */
  async connected(authority: string): Promise<void> {
    const missed = [...this.missedExpiries].filter(([, owner]) => owner === authority).map(([installId]) => installId);
    await Promise.all(missed.map((installId) => this.sendExpiry(installId, authority)));
  }

  /** Core's new preview of a staged install: undefined for one of this computer's own, else its send to the core that staged it. */
  updated(preview: ThemeInstallPreview): Promise<void> | undefined {
    return this.send(preview.installId, 'update', (authority) => this.deps.sendUpdated(authority, preview));
  }

  /** A staged install's flash check progress, as updated sends a preview. */
  progress(progress: ThemeInstallProgress): Promise<void> | undefined {
    return this.send(progress.installId, 'progress', (authority) => this.deps.sendProgress(authority, progress));
  }

  /**
   * Core dropped a staged install that waited too long: undefined for one of this computer's own, else the authority whose
   * core staged it, which is told now or, when it cannot take the word, once it connects. The install is forgotten at once,
   * so nothing else of it is sent.
   */
  expired(installId: string): string | undefined {
    const authority = this.staged.get(installId);
    if (authority === undefined) return undefined;
    this.drop(installId);
    void this.sendExpiry(installId, authority);
    return authority;
  }

  private async sendExpiry(installId: string, authority: string): Promise<void> {
    const missed = (why: string): void => {
      if (!this.missedExpiries.has(installId)) this.deps.log(`[remote] a theme install's expiry ${why}; it is sent when the host connects`);
      this.missedExpiries.delete(installId);
      this.missedExpiries.set(installId, authority);
      for (const old of [...this.missedExpiries.keys()].slice(0, Math.max(0, this.missedExpiries.size - MAX_RELAYED_INSTALLS))) this.missedExpiries.delete(old);
    };
    if (!this.deps.features(authority)?.includes(THEMES_FEATURE)) return missed(`was not sent to ${authority}: its server does not list ${THEMES_FEATURE} or is not connected`);
    try {
      await this.deps.sendExpired(authority, installId);
      this.missedExpiries.delete(installId);
    } catch (err) {
      missed(`did not reach ${authority}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private drop(installId: string): void {
    this.staged.delete(installId);
    this.unsent.delete(installId);
  }

  private send(installId: string, what: 'update' | 'progress', send: (authority: string) => Promise<void>): Promise<void> | undefined {
    const authority = this.staged.get(installId);
    if (authority === undefined) return undefined;
    if (!this.deps.features(authority)?.includes(THEMES_FEATURE)) {
      this.unsentOnce(installId, `[remote] a theme install's ${what} was not sent to ${authority}: its server does not list ${THEMES_FEATURE} or is not connected`);
      return Promise.resolve();
    }
    return send(authority).then(() => {
      this.unsent.delete(installId);
    }, (err: unknown) => {
      this.unsentOnce(installId, `[remote] a theme install's ${what} did not reach ${authority}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private unsentOnce(installId: string, line: string): void {
    if (this.unsent.has(installId)) return;
    this.unsent.add(installId);
    this.deps.log(line);
  }
}

export interface RelayedShotsDeps {
  // the daemon's welcome features; undefined while the host is not connected
  readonly features: (authority: string) => readonly string[] | undefined;
  readonly send: (authority: string, shotId: string) => Promise<void>;
  readonly log: (line: string) => void;
}

/**
 * Tells the core of `authority` that this window let go of a screenshot one of its cards may still show. A host that cannot
 * take the word keeps the card until the card's own wait ends.
 */
export async function tellShotGone(deps: RelayedShotsDeps, authority: string, shotId: string): Promise<void> {
  if (!deps.features(authority)?.includes(THEMES_FEATURE)) {
    deps.log(`[remote] a screenshot that left this window was not told to ${authority}: its server does not list ${THEMES_FEATURE} or is not connected`);
    return;
  }
  await deps.send(authority, shotId).catch((err: unknown) => {
    deps.log(`[remote] a screenshot that left this window was not told to ${authority}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export interface RelayedPreview {
  readonly authority: string;
  readonly stageId: string;
}

export interface RelayedPreviewsDeps {
  // the daemon's welcome features; undefined while the host is not connected
  readonly features: (authority: string) => readonly string[] | undefined;
  readonly send: (authority: string, ended: ThemeShowEnded) => Promise<void>;
  readonly log: (line: string) => void;
}

// A bound only: the window shows one transient preview at a time, and its end or the card's own off removes the entry.
const MAX_RELAYED_PREVIEWS = 16;

/** The remote cards whose Show in window this computer's window shows, by prompt id, so their end reaches the core that owns each. */
export class RelayedPreviews {
  private readonly shown = new Map<string, RelayedPreview>();
  private readonly deps: RelayedPreviewsDeps;

  constructor(deps: RelayedPreviewsDeps) {
    this.deps = deps;
  }

  /** Records the card; false, recording nothing, when another authority's preview holds the prompt id. */
  showing(promptId: string, preview: RelayedPreview): boolean {
    const held = this.shown.get(promptId);
    if (held !== undefined && held.authority !== preview.authority) return false;
    this.shown.delete(promptId);
    this.shown.set(promptId, preview);
    for (const old of [...this.shown.keys()].slice(0, Math.max(0, this.shown.size - MAX_RELAYED_PREVIEWS))) this.shown.delete(old);
    return true;
  }

  stopped(promptId: string, authority: string): void {
    if (this.shown.get(promptId)?.authority === authority) this.shown.delete(promptId);
  }

  /** Whether the card is a remote chat's whose preview the window shows, or of `authority` when one is given. */
  shows(promptId: string, authority?: string): boolean {
    const held = this.shown.get(promptId);
    return held !== undefined && (authority === undefined || held.authority === authority);
  }

  forgetAuthority(authority: string): void {
    for (const [promptId, held] of [...this.shown]) if (held.authority === authority) this.shown.delete(promptId);
  }

  /** The window ended the card's preview: undefined for a card of this computer's own core, else the send to the remote one. */
  ended(promptId: string, reason: ThemeShowEnded['reason']): Promise<void> | undefined {
    const preview = this.shown.get(promptId);
    if (!preview) return undefined;
    this.shown.delete(promptId);
    const { authority, stageId } = preview;
    if (!this.deps.features(authority)?.includes(THEMES_FEATURE)) {
      this.deps.log(`[remote] the end of a theme card's Show in window was not sent to ${authority}: its server does not list ${THEMES_FEATURE} or is not connected`);
      return Promise.resolve();
    }
    return this.deps.send(authority, { stageId, promptId, reason }).catch((err: unknown) => {
      this.deps.log(`[remote] the end of a theme card's Show in window did not reach ${authority}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

/** A chat page of this computer: its panel and the authority main gave it, never one a message names. */
export interface RelayPage {
  readonly panelId: string;
  readonly authority: string;
}

export interface RelayedConsentsDeps {
  readonly now: () => number;
  readonly log: (line: string) => void;
}

// A press counts for the ask that follows it within one round trip; an older one serves only a core that waited.
export const CONSENT_FRESH_MS = 60_000;
// The stages this computer's core keeps per authority (MAX_STAGES in theme-tools.ts); fewer here would end an open card early.
const MAX_CONSENT_STAGES = 20;
// The tool holds one shot at a time; a third take drops the authority's oldest from the store too.
const MAX_CONSENT_SHOTS = 2;
const MAX_CONSENT_INSTALLS = 4;
// Past this many open theme cards a page gets no new one: dropping an older card's entry would let its prompt id be bound again.
const MAX_PAGE_CARDS = 256;

type CardKind = 'change' | 'screenshot' | 'install';
// id: the stage, shot or install the card was bound to when first delivered; undefined for a card main holds nothing for
interface PageCard {
  readonly kind: CardKind;
  readonly id: string | undefined;
}
interface InstallPress {
  readonly onClash?: ThemeInstallClashChoice;
  readonly useArrangement: boolean;
  readonly at: number;
}
interface AuthorityConsents {
  readonly stages: Map<string, ThemeStagedCard>;
  readonly shots: Map<string, ThemeShot>;
  readonly installs: Map<string, ThemeInstallPreview>;
  readonly applied: Map<string, number>;
  // stage id to the card whose toggle was pressed
  readonly shown: Map<string, { readonly promptId: string; readonly at: number }>;
  readonly allowed: Map<string, number>;
  readonly installing: Map<string, InstallPress>;
}

const CARD_REQUESTS: Readonly<Record<string, CardKind>> = { requestThemeChange: 'change', requestThemeScreenshot: 'screenshot', requestThemeInstall: 'install' };
const CARD_CLOSED: Readonly<Record<string, CardKind>> = { themeChangeClosed: 'change', themeScreenshotClosed: 'screenshot', themeInstallClosed: 'install' };
/** The theme card messages whose content main checks, so a remote core sends them only as JSON text. */
export const THEME_CARD_POSTS: ReadonlySet<string> = new Set([...Object.keys(CARD_REQUESTS), 'themeInstallUpdated']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What main itself saw of a remote chat's theme cards, per authority and in memory: the stages its own core made, the shots it
 * took, the installs its core staged, the card each of its pages shows for one of those, and the presses those pages posted.
 * A remote core's request is honoured from this record alone, never from what the request says.
 */
export class RelayedConsents {
  private readonly held = new Map<string, AuthorityConsents>();
  // panel id, then prompt id; fixed from a card's first delivery until its Closed passes to that page or the page goes
  private readonly cards = new Map<string, Map<string, PageCard>>();
  private readonly deps: RelayedConsentsDeps;

  constructor(deps: RelayedConsentsDeps) {
    this.deps = deps;
  }

  stageMade(authority: string, stageId: string, card: ThemeStagedCard): void {
    const { stages } = this.of(authority);
    stages.delete(stageId);
    stages.set(stageId, card);
    for (const old of [...stages.keys()].slice(0, Math.max(0, stages.size - MAX_CONSENT_STAGES))) this.stageEnded(authority, old);
  }

  stageEnded(authority: string, stageId: string): void {
    const held = this.held.get(authority);
    held?.stages.delete(stageId);
    held?.applied.delete(stageId);
    held?.shown.delete(stageId);
  }

  /** Records the shot for the authority; the shots that left to make room, which the caller drops from the store. */
  shotTaken(authority: string, shot: ThemeShot): string[] {
    const { shots } = this.of(authority);
    shots.set(shot.shotId, shot);
    const evicted = [...shots.keys()].slice(0, Math.max(0, shots.size - MAX_CONSENT_SHOTS));
    for (const old of evicted) this.shotEnded(authority, old);
    return evicted;
  }

  /** The window's store let go of the shot: the authority it was taken for, whose it is no longer; undefined for any other shot. */
  shotGone(shotId: string): string | undefined {
    for (const authority of this.held.keys()) if (this.shotEnded(authority, shotId)) return authority;
    return undefined;
  }

  /** Whether the shot was the authority's; it is no longer. */
  shotEnded(authority: string, shotId: string): boolean {
    const held = this.held.get(authority);
    held?.allowed.delete(shotId);
    return held?.shots.delete(shotId) === true;
  }

  installMade(authority: string, preview: ThemeInstallPreview): void {
    const { installs } = this.of(authority);
    installs.delete(preview.installId);
    installs.set(preview.installId, preview);
    for (const old of [...installs.keys()].slice(0, Math.max(0, installs.size - MAX_CONSENT_INSTALLS))) this.installEnded(authority, old);
  }

  /** This computer's core's new preview of a staged install, which the install's card shows from here on. */
  installUpdated(preview: ThemeInstallPreview): void {
    for (const { installs } of this.held.values()) if (installs.has(preview.installId)) installs.set(preview.installId, preview);
  }

  installEnded(authority: string, installId: string): void {
    const held = this.held.get(authority);
    held?.installs.delete(installId);
    held?.installing.delete(installId);
  }

  /** Forget host: everything of the authority goes; its shots, which the caller drops from the store. */
  forgetAuthority(authority: string): string[] {
    const shots = [...(this.held.get(authority)?.shots.keys() ?? [])];
    this.held.delete(authority);
    return shots;
  }

  pageClosed(panelId: string): void {
    this.cards.delete(panelId);
  }

  /**
   * A message of the remote core on its way to `page`, as JSON text whose own type is `type`: the text main delivers, or
   * undefined when it delivers none. A card that names a stage, shot or install main holds for the page's authority is bound
   * to it and built again from main's record; any other change or install card gets Discard or Cancel only.
   */
  card(page: RelayPage, type: string, json: string): string | undefined {
    const closed = CARD_CLOSED[type];
    const kind = CARD_REQUESTS[type];
    if (closed === undefined && kind === undefined && type !== 'themeInstallUpdated') return json;
    let message: unknown;
    try {
      message = JSON.parse(json);
    } catch {
      message = undefined;
    }
    if (!isRecord(message) || typeof message['promptId'] !== 'string') return this.undelivered(page, type, 'it is malformed');
    const promptId = message['promptId'];
    const cards = this.cards.get(page.panelId);
    if (closed !== undefined) {
      if (cards?.get(promptId)?.kind === closed) cards.delete(promptId);
      return json;
    }
    const held = this.held.get(page.authority);
    if (kind === undefined) {
      const open = cards?.get(promptId);
      if (open?.kind !== 'install' || open.id === undefined) return json;
      const preview = held?.installs.get(open.id);
      return preview ? JSON.stringify({ type, promptId, preview }) : this.undelivered(page, type, 'its install ended on this computer');
    }
    const id = this.namedId(held, kind, message);
    const open = cards?.get(promptId);
    if (open !== undefined && (open.kind !== kind || open.id !== id)) return this.undelivered(page, type, 'the page shows another card under its prompt id');
    // a screenshot card reaches only the device whose window it shows, so one naming no shot of this computer is never honest
    if (kind === 'screenshot' && id === undefined) return this.undelivered(page, type, 'it names no screenshot this computer took for that host');
    if (open === undefined) {
      if ((cards?.size ?? 0) >= MAX_PAGE_CARDS) return this.undelivered(page, type, 'the page already holds too many theme cards');
      if (cards) cards.set(promptId, { kind, id });
      else this.cards.set(page.panelId, new Map([[promptId, { kind, id }]]));
    }
    const prompt = { type, promptId, toolUseId: message['toolUseId'] };
    const { owner } = message;
    if (id === undefined) return JSON.stringify({ ...message, otherDevice: isRecord(message['otherDevice']) ? message['otherDevice'] : {} });
    if (kind === 'screenshot') {
      const shot = held!.shots.get(id)!;
      return JSON.stringify({ ...prompt, url: shot.url, width: shot.width, height: shot.height, owner });
    }
    if (kind === 'install') return JSON.stringify({ ...prompt, preview: held!.installs.get(id), owner });
    const { state, showInWindow } = message;
    // a note this build has no sentence for is left out, so the page words every note it gets
    const showNote = THEME_SHOW_NOTES.find((note) => note === message['showNote']);
    return JSON.stringify({ ...prompt, ...held!.stages.get(id), state, showInWindow, ...(showNote !== undefined ? { showNote } : {}), owner });
  }

  /**
   * A message `page` posted for its core. A press on a card bound to something main still holds for the page's authority is
   * recorded, and only when `forwarded`: a press main drops never reaches the remote core, so it stands for nothing. The
   * card's other answers withdraw a press not yet spent.
   */
  pressed(page: RelayPage, message: unknown, forwarded: boolean): void {
    if (!isRecord(message) || typeof message['promptId'] !== 'string') return;
    const card = this.cards.get(page.panelId)?.get(message['promptId']);
    const held = this.held.get(page.authority);
    if (card?.id === undefined || !held) return;
    const { id } = card;
    const at = this.deps.now();
    switch (message['type']) {
      case 'resolveThemeChange':
        if (card.kind !== 'change' || !held.stages.has(id)) return;
        if (message['choice'] === 'apply' && forwarded) held.applied.set(id, at);
        else held.applied.delete(id);
        if (message['choice'] !== 'apply') held.shown.delete(id);
        return;
      case 'setThemeShowInWindow':
        if (card.kind !== 'change' || !held.stages.has(id)) return;
        if (message['on'] === true && forwarded) held.shown.set(id, { promptId: message['promptId'], at });
        else held.shown.delete(id);
        return;
      case 'resolveThemeScreenshot':
        if (card.kind !== 'screenshot' || !held.shots.has(id)) return;
        if (message['choice'] === 'allow' && forwarded) held.allowed.set(id, at);
        else held.allowed.delete(id);
        return;
      case 'resolveThemeInstall': {
        if (card.kind !== 'install' || !held.installs.has(id)) return;
        const { onClash, useArrangement } = message;
        const install = message['choice'] === 'install' && forwarded && (onClash === undefined || onClash === 'keepBoth' || onClash === 'replace') && typeof useArrangement === 'boolean';
        if (install) held.installing.set(id, { ...(onClash !== undefined ? { onClash } : {}), useArrangement, at });
        else held.installing.delete(id);
      }
    }
  }

  // Each spend checks and removes in one step with no await, so two asks in flight never both pass on one press.

  spendApply(authority: string, stageId: string): boolean {
    const held = this.held.get(authority);
    const at = held?.applied.get(stageId);
    held?.applied.delete(stageId);
    return this.fresh(at);
  }

  spendShow(authority: string, stageId: string, promptId: string): boolean {
    const held = this.held.get(authority);
    const press = held?.shown.get(stageId);
    if (press?.promptId !== promptId) return false;
    held?.shown.delete(stageId);
    return this.fresh(press.at);
  }

  /** Whether the shot is the authority's and its Allow was pressed; either way the Allow is spent. */
  spendAllow(authority: string, shotId: string): boolean {
    const held = this.held.get(authority);
    const at = held?.shots.has(shotId) ? held.allowed.get(shotId) : undefined;
    held?.allowed.delete(shotId);
    return this.fresh(at);
  }

  spendInstall(authority: string, installId: string): Omit<InstallPress, 'at'> | undefined {
    const held = this.held.get(authority);
    const press = held?.installs.has(installId) ? held.installing.get(installId) : undefined;
    held?.installing.delete(installId);
    if (!press || !this.fresh(press.at)) return undefined;
    return { ...(press.onClash !== undefined ? { onClash: press.onClash } : {}), useArrangement: press.useArrangement };
  }

  private fresh(at: number | undefined): boolean {
    return at !== undefined && this.deps.now() - at <= CONSENT_FRESH_MS;
  }

  private of(authority: string): AuthorityConsents {
    let held = this.held.get(authority);
    if (!held) {
      held = { stages: new Map(), shots: new Map(), installs: new Map(), applied: new Map(), shown: new Map(), allowed: new Map(), installing: new Map() };
      this.held.set(authority, held);
    }
    return held;
  }

  /** The stage, shot or install of the authority a card request names; undefined when main holds none such. */
  private namedId(held: AuthorityConsents | undefined, kind: CardKind, message: Record<string, unknown>): string | undefined {
    if (!held) return undefined;
    if (kind === 'change') return typeof message['stageId'] === 'string' && held.stages.has(message['stageId']) ? message['stageId'] : undefined;
    if (kind === 'screenshot') return [...held.shots.values()].find((shot) => shot.url === message['url'])?.shotId;
    const preview = message['preview'];
    const installId = isRecord(preview) ? preview['installId'] : undefined;
    return typeof installId === 'string' && held.installs.has(installId) ? installId : undefined;
  }

  private undelivered(page: RelayPage, type: string, why: string): undefined {
    this.deps.log(`[remote] a ${type} of ${page.authority} was not shown: ${why}`);
    return undefined;
  }
}

// a cleanup runs while the tools are off, since it only ends something here; a preview's off is one (it removes paint)
const ALWAYS: ReadonlySet<UserThemeMethod> = new Set(['discard', 'screenshotDrop', 'installCancel']);

// What the remote core hears when this computer's own side fails: the error itself can name a path of this computer.
const FAILED: Readonly<Record<UserThemeMethod, string>> = {
  read: 'The theme could not be read on the computer that shows this chat.',
  uploadStart: 'The image could not be received on the computer that shows this chat.',
  uploadChunk: 'The image could not be received on the computer that shows this chat.',
  stage: 'The change could not be prepared on the computer that shows this chat.',
  commit: 'The change could not be applied on the computer that shows this chat.',
  discard: 'The proposal could not be discarded on the computer that shows this chat.',
  preview: 'Show in window could not be changed on the computer that shows this chat.',
  screenshotTake: 'The screenshot could not be taken on the computer that shows this chat.',
  screenshot: 'The screenshot could not be read on the computer that shows this chat.',
  screenshotDrop: 'The screenshot could not be dropped on the computer that shows this chat.',
  installPrepare: 'The theme could not be downloaded on the computer that shows this chat.',
  installCommit: 'The theme could not be installed on the computer that shows this chat.',
  installCancel: 'The install could not be cancelled on the computer that shows this chat.',
};
const SHOT_NOT_ALLOWED = 'The screenshot was not sent: nobody allowed it on the computer that shows this chat.';

export async function relayTheme<M extends UserThemeMethod>(deps: ThemeRelayDeps, method: M, params: UserThemeCalls[M]['params'], signal: AbortSignal): Promise<UserThemeCalls[M]['result']> {
  const ends = ALWAYS.has(method) || (method === 'preview' && (params as UserThemeCalls['preview']['params']).on === false);
  if (!ends && !deps.enabled()) {
    deps.log(`[remote] user.theme.${method} refused for ${deps.authority}: the theme tools are off on this computer`);
    throw new Error(CLIENT_THEMES_OFF);
  }
  const { authority, consents } = deps;
  const projectOf = (folder: string | undefined): { readonly project?: RelayedThemeProject } => {
    const project = folder === undefined ? undefined : deps.project(folder);
    return project ? { project } : {};
  };
  // this computer's core or window at work for the request
  const own = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      if (err instanceof Error && err.message === CLIENT_THEMES_OFF) throw err;
      deps.log(`[remote] user.theme.${method} for ${authority} failed on this computer: ${err instanceof Error ? err.message : String(err)}`);
      // the remote core aborts the signal itself, so an abort never lets the original through
      throw new Error(signal.aborted ? 'The request was cancelled.' : FAILED[method]);
    }
  };
  // each case's answer is the method's own; TypeScript narrows params but not the generic result
  type Answer = UserThemeCalls[M]['result'];
  switch (method) {
    case 'read': {
      const { request, folder } = params as UserThemeCalls['read']['params'];
      deps.log(`[remote] user.theme.read for ${authority}: ${request.about ?? 'current'}`);
      return await own(() => deps.core['themes.relay.read']({ authority, request, ...projectOf(folder) }, signal)) as Answer;
    }
    case 'uploadStart': {
      const start = params as UserThemeCalls['uploadStart']['params'];
      if (start.bytes > MAX_THEME_UPLOAD_BYTES) throw new Error(`A theme asset is at most ${MAX_THEME_UPLOAD_BYTES / 1024 / 1024} MB`);
      deps.log(`[remote] user.theme.uploadStart for ${authority}: ${start.bytes} bytes`);
      return await own(() => deps.core['themes.relay.uploadStart']({ authority, ...start }, signal)) as Answer;
    }
    case 'uploadChunk': {
      const chunk = params as UserThemeCalls['uploadChunk']['params'];
      if (chunk.data.byteLength > THEME_UPLOAD_CHUNK_BYTES) throw new Error(`A theme upload chunk is at most ${THEME_UPLOAD_CHUNK_BYTES / 1024 / 1024} MB`);
      const ack = await own(() => deps.core['themes.relay.uploadChunk']({ authority, ...chunk }, signal));
      if (ack.complete) deps.log(`[remote] user.theme.uploadChunk for ${authority}: complete, ${ack.received} bytes`);
      return ack as Answer;
    }
    case 'stage': {
      const { folder, ...request } = params as UserThemeCalls['stage']['params'];
      deps.log(`[remote] user.theme.stage for ${authority}: ${request.tool}`);
      const answer = await own(() => deps.core['themes.relay.stage']({ authority, request, ...projectOf(folder) }, signal));
      if (answer.kind !== 'change') return answer as Answer;
      // an on-the-fly stage raises no card: this computer's keep-changes banner decides it
      if (!answer.onTheFly) consents.stageMade(authority, answer.stageId, answer.card);
      return { ...answer, computer: boundedRelayText(deps.computer(), MAX_COMPUTER_NAME_CHARS) } as Answer;
    }
    case 'commit': {
      const { stageId } = params as UserThemeCalls['commit']['params'];
      const pressed = consents.spendApply(authority, stageId);
      deps.log(`[remote] user.theme.commit for ${authority}: ${pressed ? 'Apply was pressed on this computer' : 'no Apply was pressed on this computer'}`);
      const answer = await own(() => deps.core['themes.relay.commit']({ authority, stageId, pressed }, signal));
      // an outdated card waits for Discard, and an ask refused with no press ended nothing
      const kept = 'outcome' in answer ? answer.outcome === 'outdated' : !pressed;
      if (!kept) consents.stageEnded(authority, stageId);
      return answer as Answer;
    }
    case 'discard': {
      const { stageId, keepDraft } = params as UserThemeCalls['discard']['params'];
      await own(() => deps.core['themes.relay.discard']({ authority, stageId, ...(keepDraft === true ? { keepDraft: true } : {}) }, signal));
      consents.stageEnded(authority, stageId);
      return undefined as Answer;
    }
    case 'preview': {
      const { stageId, promptId, on } = params as UserThemeCalls['preview']['params'];
      if (!on) {
        deps.previews.stopped(promptId, authority);
        await own(() => deps.core['themes.relay.preview']({ authority, stageId, promptId, on: false }, signal));
        return { showing: false } as Answer;
      }
      if (!consents.spendShow(authority, stageId, promptId)) {
        deps.log(`[remote] user.theme.preview refused for ${authority}: Show in window was not turned on for that card on this computer`);
        return { showing: false } as Answer;
      }
      // recorded before the window shows it, so an end that overtakes the answer still finds the card's core
      if (!deps.previews.showing(promptId, { authority, stageId })) {
        deps.log(`[remote] user.theme.preview refused for ${authority}: another host's card holds that prompt id`);
        return { showing: false } as Answer;
      }
      try {
        const answer = await own(() => deps.core['themes.relay.preview']({ authority, stageId, promptId, on: true }, signal));
        // gone by now: the window ended it while this computer's core answered
        if (answer.showing && deps.previews.shows(promptId, authority)) return answer as Answer;
        deps.previews.stopped(promptId, authority);
        return { showing: false, ...(!answer.showing && answer.refused !== undefined ? { refused: answer.refused } : {}) } as Answer;
      } catch (err) {
        deps.previews.stopped(promptId, authority);
        throw err;
      }
    }
    case 'screenshotTake': {
      deps.log(`[remote] user.theme.screenshotTake for ${authority}`);
      const shot = await own(() => deps.screenshots.take(signal));
      for (const evicted of consents.shotTaken(authority, shot)) {
        await deps.screenshots.drop(evicted);
        await deps.shotGone(evicted);
      }
      return shot as Answer;
    }
    case 'screenshot': {
      const { shotId } = params as UserThemeCalls['screenshot']['params'];
      // checked and spent before the first await: the shot leaves once
      const allowed = consents.spendAllow(authority, shotId);
      if (!allowed || !consents.shotEnded(authority, shotId)) {
        deps.log(`[remote] user.theme.screenshot refused for ${authority}: it is not that host's shot, or its Allow was not pressed on this computer`);
        throw new Error(SHOT_NOT_ALLOWED);
      }
      let png: Uint8Array;
      try {
        png = await own(() => deps.screenshots.read(shotId, signal));
      } finally {
        await deps.screenshots.drop(shotId);
      }
      if (png.byteLength > MAX_RELAYED_THEME_PNG_BYTES) {
        deps.log(`[remote] user.theme.screenshot refused for ${authority}: ${png.byteLength} bytes`);
        throw new Error(`The screenshot was not sent: it is larger than ${MAX_RELAYED_THEME_PNG_BYTES / 1024 / 1024} MB.`);
      }
      deps.log(`[remote] user.theme.screenshot sent to ${authority} after its Allow on this computer`);
      return { png } as Answer;
    }
    case 'screenshotDrop': {
      const { shotId } = params as UserThemeCalls['screenshotDrop']['params'];
      if (consents.shotEnded(authority, shotId)) await own(() => deps.screenshots.drop(shotId));
      return undefined as Answer;
    }
    case 'installPrepare': {
      const { url } = params as UserThemeCalls['installPrepare']['params'];
      deps.log(`[remote] user.theme.installPrepare for ${authority}`);
      const prepared = await own(() => deps.core['themes.relay.installPrepare']({ authority, url }, signal));
      if ('refused' in prepared) return prepared as Answer;
      deps.installs.add(prepared.preview.installId, authority);
      consents.installMade(authority, prepared.preview);
      return { preview: prepared.preview, computer: boundedRelayText(deps.computer(), MAX_COMPUTER_NAME_CHARS) } as Answer;
    }
    case 'installCommit': {
      const { installId, chat } = params as UserThemeCalls['installCommit']['params'];
      const press = consents.spendInstall(authority, installId);
      if (!press) {
        deps.log(`[remote] user.theme.installCommit refused for ${authority}: no Install was pressed for it on this computer`);
        return { refused: l('Nobody pressed Install for this theme on the computer that shows this chat, so nothing was installed.') } as Answer;
      }
      deps.log(`[remote] user.theme.installCommit for ${authority}: Install was pressed on this computer`);
      // the options are the press's own; the request names only the install and the chat the history entry shows
      const commit = { authority, installId, ...(press.onClash !== undefined ? { onClash: press.onClash } : {}), useArrangement: press.useArrangement, chat: { id: chat.id, ...(chat.title !== undefined ? { title: chat.title } : {}) } };
      const committed = await own(() => deps.core['themes.relay.installCommit'](commit, signal));
      if ('installed' in committed) {
        deps.installs.ended(installId, authority);
        consents.installEnded(authority, installId);
      } else if (committed.preview) {
        consents.installUpdated(committed.preview);
      }
      return committed as Answer;
    }
    case 'installCancel': {
      const { installId } = params as UserThemeCalls['installCancel']['params'];
      // core cancels only an install this authority staged, and the entries here are this authority's own
      await own(() => deps.core['themes.relay.installCancel']({ authority, installId }, signal));
      deps.installs.ended(installId, authority);
      consents.installEnded(authority, installId);
      return undefined as Answer;
    }
    default:
      throw new Error(`user.theme.${String(method)} is not a theme relay request`);
  }
}

const INSTALL_ID = /^[0-9A-Za-z_-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Allow flashing for this file, pressed on a remote chat's install card on this computer's page. Main sends it to this
 * computer's core with the authority of its own view, never through the chat's remote core; that core allows only a file an
 * install it staged for that authority lists as flagged. Whether the file may flash now.
 */
export async function allowRelayedInstallFlash(deps: ThemeRelayDeps, message: unknown, signal: AbortSignal): Promise<boolean> {
  const { installId, sha256 } = (typeof message === 'object' && message !== null ? message : {}) as { readonly installId?: unknown; readonly sha256?: unknown };
  if (typeof installId !== 'string' || !INSTALL_ID.test(installId) || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    deps.log(`[remote] a malformed Allow flashing from a chat on ${deps.authority} was dropped`);
    return false;
  }
  if (!deps.enabled()) {
    deps.log(`[remote] Allow flashing from a chat on ${deps.authority} refused: the theme tools are off on this computer`);
    return false;
  }
  const { allowed } = await deps.core['themes.relay.allowFlash']({ authority: deps.authority, installId, sha256 }, signal);
  deps.log(`[remote] Allow flashing of ${sha256} from a chat on ${deps.authority}: ${allowed ? 'allowed' : 'refused, no install of that host lists it as flagged'}`);
  return allowed;
}
