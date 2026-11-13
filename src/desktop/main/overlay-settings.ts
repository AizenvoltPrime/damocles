import type { WebContents } from 'electron';
import type { Disposable } from '../../platform/disposable';
import type { SettingsStore } from '../../platform/settings-store';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../shared/types/messages';
import type { HostColor } from '../../shared/host-colors';
import { isSettingsAccountId, isSettingsSectionId, type SettingsTarget } from '../../shared/settings-sections';
import { SETTINGS_VIEW_REQUEST_TYPES } from '../../shared/settings-view-messages';
import { MAX_SETTINGS_MESSAGE_CHARS, OVERLAY_CHANNELS, type OverlayPrefs, type OverlayPrefWrite, type OverlayRect, type OverlaySettingsAwayState, type OverlaySettingsPage, type OverlaySettingsScopes } from '../preload/overlay-channels';
import type { TerminalProfileReport } from '../preload/terminal-channels';
import { NEW_CHAT_ID_PREFIX, type HostUpdate, type ProjectConnection } from '../preload/shell-channels';
import type { HostReconnectPhase } from '../../shared/host-connection';
import type { CoreState } from '../daemon/control-messages';
import type { RemoteConnection } from './remote/connection';
import { DESKTOP_CONFIGURATION, isDesktopSettingValue, TERMINAL_PROFILES_SETTING, type DesktopLanguageSetting } from '../local-services/desktop-configuration';
import { parseRect, type OverlayHost } from './overlay';
import { isVersion } from './release-notes';
import { asJsonValue, isWebviewMessage } from './views';

// A core's side of the settings modal (PanelManager.attachView): an attachment is named by its generation.
export interface SettingsViewHost {
  attachSettingsView(panelId: string, attachment: number, view: { post(message: ExtensionToWebviewMessage): void; detached(): void }, scope?: SettingsScope): Promise<Disposable>;
  dispatchSettingsView(attachment: number, message: WebviewToExtensionMessage): Promise<void>;
}

export const SETTINGS_SCOPES = ['user', 'machine', 'project'] as const;
export type SettingsScope = (typeof SETTINGS_SCOPES)[number];

// The chat panel a settings tab attaches to, on its core; scope names the tab (absent: a local chat, which shows no tabs).
export interface SettingsAttachTarget {
  readonly host: SettingsViewHost;
  readonly panelId: string;
  readonly scope?: SettingsScope;
  readonly page: OverlaySettingsPage;
}

/**
 * The chat a settings page names: its stored session, else the token its page keeps, which a remote chat reopened in a new
 * view after its core restarted or its host attached fresh keeps too, else its view.
 */
export function settingsPageChat(sessionId: string | undefined, view: { readonly panelId: string; readonly panelToken: string | undefined }): string {
  return sessionId ?? `${NEW_CHAT_ID_PREFIX}${view.panelToken ?? view.panelId}`;
}

// The tabs a remote chat's settings show: User (the local core), its host (machine scope) and Project.
export interface SettingsScopes {
  // canAllowYolo: the host has a saved record, so main may ask to allow YOLO on it
  readonly host: { readonly authority: string; readonly name: string; readonly color?: HostColor; readonly canAllowYolo?: true };
  readonly projectFile?: string;
}

export interface OverlaySettingsDeps {
  readonly overlay: OverlayHost;
  readonly settings: SettingsStore;
  // the panel the tab attaches to: the selected chat's, else an empty chat on the default project the promptTarget rule
  // opens; undefined when no chat could be had
  readonly target: (scope: SettingsScope | undefined) => Promise<SettingsAttachTarget | undefined>;
  // the scope tabs for the selected chat; undefined for a local chat
  readonly scopes: () => SettingsScopes | undefined;
  // the webContents keyboard focus returns to when the modal closes
  readonly focused: () => WebContents | undefined;
  readonly relaunch: () => void;
  readonly resetLayout: () => void;
  // Settings › Terminal's profiles: the listed ones (its default profile), the hidden detected ones and the refused entries
  readonly terminalProfiles: () => TerminalProfileReport;
  readonly log: (line: string) => void;
  readonly languageAtLaunch: DesktopLanguageSetting;
  // a saved SSH host's id, which a target's host must name
  readonly knownHost: (hostId: string) => boolean;
  // asks to allow YOLO on the authority's saved host, hung from anchor; resolves whether it allows YOLO now
  readonly allowYolo: (authority: string, anchor: OverlayRect) => Promise<boolean>;
  // the connection banner's Sign in for the authority's saved host: the Connect dialog on its waiting prompt, which ends the
  // modal; settles once that dialog closed, or at once when it opened none
  readonly signIn: (authority: string) => Promise<void>;
  // why the authority's core cannot serve its tabs; undefined once it is up and the selected chat is not reopening with it
  readonly hostAway: (authority: string) => OverlaySettingsAwayState | undefined;
}

// What main knows of an authority whose host or Project tab may wait for its core.
export interface HostCoreFacts {
  // a usable connection, neither suspect nor lost
  readonly connected: boolean;
  readonly reconnect: HostReconnectPhase | undefined;
  readonly state: ProjectConnection;
  // a daemon of another protocol answered, and the update flow connects the host once that daemon is gone
  readonly handedOff: boolean;
  // that flow's banner: absent until it finds the daemon busy; its offer waits for the user's Switch now or Switch when idle
  readonly update: HostUpdate | undefined;
  // the engine is halted until Restart Engine
  readonly halted: boolean;
  // a Restart the user asked for is in flight, or the daemon is restarting or starting the engine
  readonly restarting: boolean;
  // the core is ready and the selected chat is not reopening on it
  readonly coreUp: boolean;
  // the chats reopened on this connection before, so a core it lacks now is a restart, not a reconnection
  readonly reopened: boolean;
}

/** Why the tab waits: offline once nothing reconnects the host (Disconnect, a removal, a loop that stopped). */
export function hostAwayOf(facts: HostCoreFacts): OverlaySettingsAwayState | undefined {
  if (!facts.connected) {
    if (facts.reconnect === 'signIn' || facts.reconnect === 'failed') return { state: facts.reconnect };
    // only the user ends an offer, on the update banner
    if (facts.handedOff && facts.update?.phase === 'offer') return { state: 'switchOffered', update: { serverVersion: facts.update.serverVersion, runningAgents: facts.update.runningAgents } };
    if (facts.reconnect !== undefined || facts.handedOff) return { state: 'reconnecting' };
    return { state: facts.state === 'connecting' || facts.state === 'connected' ? 'reconnecting' : 'offline' };
  }
  // the title bar pill's order (RemoteCore.engineState)
  if (facts.restarting) return { state: 'restarting' };
  if (facts.halted) return { state: 'halted' };
  if (facts.coreUp) return undefined;
  return { state: facts.reopened ? 'restarting' : 'reconnecting' };
}

// Where main reads an authority's facts from.
export interface HostCoreSources {
  // the authority's usable connection
  readonly connection: RemoteConnection | undefined;
  readonly reconnect: HostReconnectPhase | undefined;
  readonly state: ProjectConnection;
  // the update flow following a daemon of another protocol on the authority
  readonly followed: { update(): HostUpdate | undefined } | undefined;
  readonly core: {
    readonly host: { halted(): boolean; current(): unknown };
    isRestarting(): boolean;
    coreStateOn(connection: RemoteConnection): CoreState | undefined;
    reopenedOn(connection: RemoteConnection): boolean;
  } | undefined;
  // the selected chat closed with this authority's core and reopens selected
  readonly reopeningSelected: boolean;
}

/** The facts hostAwayOf reads: the engine's phase only as the current connection reported it. */
export function hostCoreFacts(sources: HostCoreSources): HostCoreFacts {
  const { connection, core } = sources;
  const phase = connection === undefined ? undefined : core?.coreStateOn(connection)?.phase;
  return {
    connected: connection !== undefined,
    reconnect: sources.reconnect,
    state: sources.state,
    handedOff: sources.followed !== undefined,
    update: sources.followed?.update(),
    halted: core?.host.halted() === true || phase === 'halted',
    restarting: core?.isRestarting() === true || phase === 'restarting' || phase === 'starting',
    coreUp: core?.host.current() !== undefined && !sources.reopeningSelected,
    reopened: connection !== undefined && core?.reopenedOn(connection) === true,
  };
}

// A remote tab's chat lookup runs on its host's core only while that core is up, so a reload or restart makes the tab wait instead of block.
export async function lookupOnUpCore<C extends { hasEnded(): boolean }, T>(host: { current(): C | undefined }, lookup: (core: C) => Promise<T | undefined>): Promise<T | undefined> {
  const core = host.current();
  if (core === undefined) return undefined;
  const found = await lookup(core);
  return core.hasEnded() ? undefined : found;
}

function shownHost(host: SettingsScopes['host']): OverlaySettingsScopes['host'] {
  return { name: host.name, ...(host.color !== undefined ? { color: host.color } : {}), ...(host.canAllowYolo ? { canAllowYolo: true } : {}) };
}

/** The one write path for a damocles.desktop.* value: checked against its declaration, written to user settings (D37). */
export async function writeDesktopSetting(settings: SettingsStore, key: string, value: unknown): Promise<void> {
  if (!isDesktopSettingValue(key, value)) throw new Error('Not a desktop setting value');
  await settings.update(key, value, 'user');
}

// a re-attached page sends a few state requests; a renderer sending more while an attach waits on core is not answered for them
const MAX_HELD_SENDS = 32;

interface Attachment {
  readonly host: SettingsViewHost;
  readonly panelId: string;
  readonly scope: SettingsScope | undefined;
  readonly page: OverlaySettingsPage;
  readonly generation: number;
  readonly handle: Disposable;
  // false once core detached it (the chat closed, or another view took its place)
  live: boolean;
}

/**
 * The settings modal in the overlay (plan AD2): attaches it to the selected chat with PanelManager.attachView, re-attaches
 * it when the selection changes, and carries its messages both ways. Each attachment has a generation, and a message the
 * renderer sent for an earlier one is dropped, so a write meant for one chat never lands on another.
 */
export class OverlaySettings {
  private readonly deps: OverlaySettingsDeps;
  private open = false;
  private generation = 0;
  private attachment: Attachment | undefined;
  // the tab shown while the selected chat is remote, the host tab first, as a remote chat's settings open on it: the core
  // attached, or while away is set, the host's core it waits for
  private scope: SettingsScope | undefined;
  private scopeHost: string | undefined;
  // the host or Project tab shown lost its host's core: it stays selected and attaches again once that core is ready
  private away: { readonly authority: string; readonly away: OverlaySettingsAwayState } | undefined;
  // sign-ins, provider keys and this computer's hosts change only in the User tab, so a target naming them opens it
  private userTab = false;
  // settles when the open modal ends
  private ended: Promise<void> = Promise.resolve();
  // authorities whose connection replacing() swaps, which a waiting tab hears of only once the next attempt started
  private readonly replaced = new Set<string>();
  // attach work runs one at a time, so a selection change during an attach never leaves two views
  private attaching: Promise<void> = Promise.resolve();
  // The re-attach under way: the renderer has its generation (settingsAttached goes first) and asks for state at once, so
  // what it sends for it waits here and goes once core attached it.
  private inFlight: { readonly generation: number; readonly sends: WebviewToExtensionMessage[] } | undefined;
  private readonly prefsWatch: Disposable;

  constructor(deps: OverlaySettingsDeps) {
    this.deps = deps;
    const { overlay } = deps;
    this.prefsWatch = deps.settings.onDidChange('damocles.desktop', () => {
      if (this.open) overlay.send(OVERLAY_CHANNELS.prefsChanged, this.prefs());
    });
    overlay.on(OVERLAY_CHANNELS.settingsSend, (raw) => this.receive(raw));
    overlay.handle(OVERLAY_CHANNELS.prefsGet, () => this.prefs());
    const settingsOpen = (): boolean => this.open;
    overlay.handleWhileOpen(OVERLAY_CHANNELS.prefsSet, settingsOpen, (raw) => this.setPref(raw));
    overlay.handleWhileOpen(OVERLAY_CHANNELS.settingsScope, settingsOpen, (raw) => this.selectScope(raw));
    overlay.handleWhileOpen(OVERLAY_CHANNELS.settingsAllowYolo, settingsOpen, (raw) => this.allowYolo(raw));
    overlay.handleWhileOpen(OVERLAY_CHANNELS.settingsSignIn, settingsOpen, (raw) => this.signIn(raw));
    overlay.handleWhileOpen(OVERLAY_CHANNELS.relaunch, settingsOpen, () => deps.relaunch());
    overlay.handleWhileOpen(OVERLAY_CHANNELS.layoutReset, settingsOpen, () => deps.resetLayout());
    overlay.handleWhileOpen(OVERLAY_CHANNELS.terminalProfiles, settingsOpen, (raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length > 0) throw new Error('Malformed terminal profiles request');
      return deps.terminalProfiles();
    });
  }

  /**
   * Opens the modal on the target's section, with its account or release expanded there, attached to the selected chat;
   * resolves once it has closed. While it shows, the modal goes to the target instead.
   */
  async show(request: SettingsTarget, scope?: 'machine'): Promise<void> {
    const { section, account, release, host, forgeServer, forgeSignIn, forgeAccount } = request;
    if (section !== undefined && !isSettingsSectionId(section)) throw new Error('Unknown settings section');
    if (account !== undefined && !isSettingsAccountId(account)) throw new Error('Unknown settings account');
    if (release !== undefined && !isVersion(release)) throw new Error('Unknown release');
    if (host !== undefined && !this.deps.knownHost(host)) throw new Error('Unknown host');
    // a forge server id is a host[:port][/path]; the settings view opens only a row it lists
    if (forgeServer !== undefined && (forgeServer.length === 0 || forgeServer.length > 512)) throw new Error('Unknown Git hosting server');
    if (forgeSignIn !== undefined && forgeSignIn !== true) throw new Error('Malformed Git hosting sign-in target');
    // an account id is "<serverId>|<userId>"; the settings view opens only an account it lists on that server
    if (forgeAccount !== undefined && (forgeServer === undefined || !forgeAccount.startsWith(`${forgeServer}|`) || forgeAccount.length > 1024)) throw new Error('Unknown Git hosting account');
    const target: SettingsTarget = {
      ...(section !== undefined ? { section } : {}),
      ...(account !== undefined ? { account } : {}),
      ...(release !== undefined ? { release } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(forgeServer !== undefined ? { forgeServer } : {}),
      ...(forgeServer !== undefined && forgeSignIn === true ? { forgeSignIn } : {}),
      ...(forgeAccount !== undefined ? { forgeAccount } : {}),
    };
    const userTab = section === 'accounts' || account !== undefined || section === 'remoteHosts' || host !== undefined || forgeServer !== undefined;
    if (this.open) {
      this.deps.overlay.send(OVERLAY_CHANNELS.settingsTarget, target);
      if (userTab && this.scope !== undefined && this.scope !== 'user') await this.reattach('user');
      // a host-tab target moves the open modal of a remote chat to that tab, whichever tab it shows
      else if (scope === 'machine' && this.scope !== undefined && this.scope !== 'machine') await this.reattach('machine');
      return;
    }
    this.open = true;
    this.userTab = userTab;
    let end!: () => void;
    this.ended = new Promise((resolve) => (end = resolve));
    const returnFocus = this.deps.focused();
    try {
      await this.reattach();
      // The window closed while the modal was opening.
      if (!this.open) return;
      const attachment = this.attachment;
      if (attachment === undefined) throw new Error('No chat could be opened for the settings');
      const scopes = this.scopesShown();
      await this.deps.overlay.request({ kind: 'settings', ...target, generation: attachment.generation, page: attachment.page, ...(scopes ? { scopes } : {}) }, returnFocus);
    } finally {
      this.open = false;
      this.scope = undefined;
      this.scopeHost = undefined;
      this.away = undefined;
      this.userTab = false;
      this.generation++;
      const attachment = this.attachment;
      this.attachment = undefined;
      attachment?.handle.dispose();
      end();
    }
  }

  dispose(): void {
    this.prefsWatch.dispose();
  }

  /** From the start of show() until the modal closed, the attach before the modal appears included. */
  showing(): boolean {
    return this.open;
  }

  /** The attachment the open modal's messages must carry; undefined while it is closed. */
  attachedGeneration(): number | undefined {
    return this.attachment?.generation;
  }

  /** The window is closing: the modal goes with it and follows none of the chats the close unloads. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.deps.overlay.dismiss('settings');
  }

  /**
   * A core ended without detaching its views (a crash, a halt, a reload). When the modal is attached to it, nothing it
   * sends reaches a chat until it attaches to the next core's, which an open modal does once that core is ready.
   */
  coreEnded(host: SettingsViewHost): void {
    if (this.attachment?.host !== host) return;
    this.attachment.live = false;
    this.selectionChanged();
  }

  /** The authority's core is ready and its chats reopened: a tab waiting for it attaches again. */
  coreReady(authority: string): void {
    if (this.open && this.away?.authority === authority) this.selectionChanged();
  }

  /** The authority's connection, reconnect loop or engine changed: a tab waiting for its core tells why it waits. */
  authorityChanged(authority: string): void {
    if (!this.open || this.away?.authority !== authority || this.replaced.has(authority)) return;
    if (!this.waitFor(authority)) this.selectionChanged();
  }

  /**
   * Runs swap, which ends the authority's connection and starts the next attempt, and only then tells a tab waiting for it
   * why it waits, so the drop in between never reads as offline.
   */
  replacing(authority: string, swap: () => void): void {
    this.replaced.add(authority);
    try {
      swap();
    } finally {
      this.replaced.delete(authority);
    }
    this.authorityChanged(authority);
  }

  // false when the authority's core is up, so there is nothing to wait for
  private waitFor(authority: string): boolean {
    const away = this.deps.hostAway(authority);
    if (away === undefined) return false;
    this.setAway({ authority, away });
    return true;
  }

  private setAway(next: { readonly authority: string; readonly away: OverlaySettingsAwayState } | undefined): void {
    if (JSON.stringify(this.away) === JSON.stringify(next)) return;
    this.away = next;
    this.deps.overlay.send(OVERLAY_CHANNELS.settingsAway, next?.away ?? null);
  }

  /** The selected chat may have changed; an open modal follows it. */
  selectionChanged(): void {
    if (!this.open) return;
    this.reattach().catch((err: unknown) => this.deps.log(`[settings] re-attaching to the selected chat failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  // requested: a tab the user picked, which fails rather than attach another; else the selected chat's tab. retry: this
  // attach follows a failed one, so failing again leaves the modal unattached rather than trying forever.
  private reattach(requested?: SettingsScope, retry = false): Promise<void> {
    const run = this.attaching.then(() => this.attachToTarget(requested, retry));
    this.attaching = run.catch(() => undefined);
    return run;
  }

  // The tab to attach for the selected chat: a chat of another host starts on that host's tab, and a local chat shows none.
  private wantedScope(requested: SettingsScope | undefined): { scope: SettingsScope | undefined; host: string | undefined } {
    const scopes = this.deps.scopes();
    if (!scopes) return { scope: undefined, host: undefined };
    const host = scopes.host.authority;
    if (requested !== undefined) return { scope: requested, host };
    if (this.scopeHost === host && this.scope !== undefined) return { scope: this.scope, host };
    return { scope: this.userTab ? 'user' : 'machine', host };
  }

  /** A host was renamed or recolored: the open modal's host tab follows when it shows that host. */
  hostChanged(authority: string): void {
    const scopes = this.deps.scopes();
    if (!this.open || this.scope === undefined || scopes?.host.authority !== authority) return;
    this.deps.overlay.send(OVERLAY_CHANNELS.settingsScopeHost, shownHost(scopes.host));
  }

  // Only a remote chat's host or Project tab asks, and always for the attached tab's host, never one the renderer names.
  private async allowYolo(raw: unknown): Promise<boolean> {
    const anchor = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === 1 ? parseRect((raw as { anchor?: unknown }).anchor) : undefined;
    if (!anchor) throw new Error('Malformed allow YOLO request');
    const host = this.scopeHost;
    if (host === undefined || this.scope === undefined || this.scope === 'user') throw new Error('No remote host tab shows');
    // the selection moved to another host's chat, whose tab is not attached yet
    if (host !== this.deps.scopes()?.host.authority) throw new Error('The settings are re-attaching to another chat');
    return this.deps.allowYolo(host, anchor);
  }

  // The waiting tab's Sign in, always for the host that tab waits for, never one the renderer names; a click the wait or the
  // selection moved past since does nothing. Answers once the Connect dialog ended the modal, or opened none.
  private async signIn(raw: unknown): Promise<void> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length > 0) throw new Error('Malformed sign-in request');
    const away = this.away;
    if (away?.away.state !== 'signIn' || away.authority !== this.deps.scopes()?.host.authority) return;
    await Promise.race([this.deps.signIn(away.authority), this.ended]);
  }

  private scopesShown(): OverlaySettingsScopes | undefined {
    const scopes = this.deps.scopes();
    if (!scopes || this.scope === undefined) return undefined;
    return {
      host: shownHost(scopes.host),
      ...(scopes.projectFile !== undefined ? { projectFile: scopes.projectFile } : {}),
      active: this.scope,
    };
  }

  // The renderer's tab click: the modal re-attaches to that tab's core, and answers the tab attached, which a failed attach
  // leaves as it was. It queues behind a click still attaching, even one for the tab shown, so the later click wins.
  private async selectScope(raw: unknown): Promise<SettingsScope> {
    const scope = (raw as { scope?: unknown } | null)?.scope;
    if (!SETTINGS_SCOPES.includes(scope as SettingsScope)) throw new Error('Unknown settings scope');
    if (this.scope === undefined) throw new Error('The selected chat has no settings scopes');
    await this.reattach(scope as SettingsScope);
    if (this.scope !== scope) throw new Error('The settings of that tab could not be opened');
    return this.scope;
  }

  private async targetOf(scope: SettingsScope | undefined): Promise<SettingsAttachTarget | undefined> {
    try {
      return await this.deps.target(scope);
    } catch (err) {
      this.deps.log(`[settings] finding the chat of the ${scope ?? 'chat'} settings failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  // Leaves the attachment and its tab as they were when no chat answers, so the tab shown names the core attached, or the
  // host's core it waits for.
  private async attachToTarget(requested: SettingsScope | undefined, retry: boolean): Promise<void> {
    if (!this.open) return;
    const wanted = this.wantedScope(requested);
    let scope = wanted.scope;
    let target = await this.targetOf(scope);
    // no chat answers the host or Project tab shown: once that core left its attachment and is not up, the tab waits for it;
    // a first attach, one from a live attachment, or one whose core is up without the chat opens the User tab
    if (target === undefined && requested === undefined && scope !== undefined && scope !== 'user' && wanted.host !== undefined) {
      const left = this.open && this.scope === scope && this.scopeHost === wanted.host && this.attachment?.live === false;
      if (left && this.waitFor(wanted.host)) return;
      // the core may have come back while its chat was looked up, before anything waited for it
      if (left) target = await this.targetOf(scope);
      if (target === undefined) {
        scope = 'user';
        target = await this.targetOf(scope);
      }
    }
    if (!this.open || target === undefined) return;
    const previous = { scope: this.scope, host: this.scopeHost };
    this.scope = scope;
    this.scopeHost = wanted.host;
    const { host, panelId } = target;
    const current = this.attachment;
    if (current !== undefined && current.host === host && current.panelId === panelId && current.scope === target.scope && current.live) return;
    const generation = ++this.generation;
    // the waiting tab stays inert until its own attach is live; any other attach ends the wait before the renderer hears of it
    const resumes = target.scope !== undefined && target.scope !== 'user' && this.away?.authority === wanted.host;
    if (!resumes) this.setAway(undefined);
    // Sent before the attach, which posts the chat's host prompts to the view; the renderer drops the earlier ones on this.
    // The first attachment's generation and page travel in the request itself.
    const scopes = this.scopesShown();
    if (current !== undefined) this.deps.overlay.send(OVERLAY_CHANNELS.settingsAttached, { generation, page: target.page, ...(scopes ? { scopes } : {}) });
    const inFlight = { generation, sends: [] as WebviewToExtensionMessage[] };
    this.inFlight = inFlight;
    const held = (): readonly WebviewToExtensionMessage[] => {
      if (this.inFlight !== inFlight) return [];
      this.inFlight = undefined;
      return inFlight.sends;
    };
    let detachedEarly = false;
    let handle: Disposable;
    try {
      // Both callbacks compare this.generation, not this.attachment: the attach posts before it resolves.
      handle = await host.attachSettingsView(panelId, generation, {
        post: (message) => {
          if (this.generation === generation) this.deps.overlay.send(OVERLAY_CHANNELS.settingsMessage, message);
        },
        // The chat closed under the open modal: it follows the selection to another chat.
        detached: () => {
          if (this.attachment?.generation === generation) this.attachment.live = false;
          else detachedEarly = true;
          if (this.open && this.generation === generation) this.selectionChanged();
        },
      }, target.scope);
    } catch (err) {
      this.dropHeld(held().length);
      if (this.generation === generation) {
        if (current !== undefined) current.live = false;
        // the renderer shows the new tab, whose core ended under the attach: that tab waits for the core
        if (current !== undefined && target.scope !== undefined && target.scope !== 'user' && wanted.host !== undefined && this.open && this.waitFor(wanted.host)) return;
        // The renderer already took the new generation: the previous tab attaches again under a newer one.
        this.scope = previous.scope;
        this.scopeHost = previous.host;
        if (current !== undefined && !retry && this.open) {
          this.reattach(undefined, true).catch((again: unknown) => this.deps.log(`[settings] attaching the previous tab again failed: ${again instanceof Error ? again.message : String(again)}`));
        } else if (this.away !== undefined && this.deps.hostAway(this.away.authority) === undefined && this.open) {
          // a core that is up refused the waiting tab twice: the User tab opens, as for a tab whose chat is gone
          this.setAway(undefined);
          this.reattach('user', true).catch((again: unknown) => this.deps.log(`[settings] opening the User tab failed: ${again instanceof Error ? again.message : String(again)}`));
        }
      }
      throw err;
    }
    const sends = held();
    // the modal closed while core attached it
    if (this.generation !== generation) {
      this.dropHeld(sends.length);
      handle.dispose();
      return;
    }
    const attachment: Attachment = { host, panelId, scope: target.scope, page: target.page, generation, handle, live: !detachedEarly };
    this.attachment = attachment;
    current?.handle.dispose();
    if (attachment.live) this.setAway(undefined);
    for (const message of sends) this.deliver(attachment, message);
  }

  private dropHeld(count: number): void {
    if (count > 0) this.deps.log(`[settings] dropped ${count} settings messages sent for an attachment that did not attach`);
  }

  private receive(raw: unknown): void {
    const envelope = asJsonValue(raw, MAX_SETTINGS_MESSAGE_CHARS);
    const value = envelope?.value as { generation?: unknown; message?: unknown } | undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.deps.log('[settings] dropped a malformed or oversized settings message');
      return;
    }
    const message = value.message;
    // Only the type is ever logged: these messages carry API keys and prompt answers.
    if (!isWebviewMessage(message) || !SETTINGS_VIEW_REQUEST_TYPES.has(message.type)) {
      this.deps.log(`[settings] refused a settings message of type ${isWebviewMessage(message) ? JSON.stringify(message.type.slice(0, 64)) : 'none'}`);
      return;
    }
    if (this.open && this.inFlight !== undefined && value.generation === this.inFlight.generation) {
      if (this.inFlight.sends.length >= MAX_HELD_SENDS) this.deps.log('[settings] dropped a settings message: too many wait for the attach under way');
      else this.inFlight.sends.push(message as WebviewToExtensionMessage);
      return;
    }
    const attachment = this.attachment;
    if (!this.open || attachment === undefined || value.generation !== attachment.generation) {
      this.deps.log('[settings] dropped a settings message sent for an earlier attachment');
      return;
    }
    this.deliver(attachment, message as WebviewToExtensionMessage);
  }

  private deliver(attachment: Attachment, message: WebviewToExtensionMessage): void {
    if (!attachment.live) {
      this.deps.log('[settings] dropped a settings message: the chat or engine it was attached to is gone');
      return;
    }
    attachment.host.dispatchSettingsView(attachment.generation, message)
      .catch((err: unknown) => this.deps.log(`[settings] ${message.type} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** The profiles were validated again: the open modal gets the new report. */
  terminalProfilesChanged(): void {
    if (this.open) this.deps.overlay.send(OVERLAY_CHANNELS.terminalProfilesChanged, this.deps.terminalProfiles());
  }

  private prefs(): OverlayPrefs {
    return {
      // Settings › Terminal reads the validated profile report, never the raw profile entries
      values: Object.fromEntries(Object.keys(DESKTOP_CONFIGURATION).filter((key) => key !== TERMINAL_PROFILES_SETTING).map((key) => [key, this.deps.settings.get(key)])),
      languageAtLaunch: this.deps.languageAtLaunch,
    };
  }

  private async setPref(raw: unknown): Promise<OverlayPrefWrite> {
    const request = raw as { key?: unknown; value?: unknown } | null;
    if (typeof request !== 'object' || request === null || typeof request.key !== 'string') return { ok: false, error: 'Not a desktop setting value' };
    try {
      await writeDesktopSetting(this.deps.settings, request.key, request.value);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const file = this.deps.settings.scopeFile('user');
    if (file === undefined) throw new Error('The desktop settings store has no user file');
    return { ok: true, file };
  }
}
