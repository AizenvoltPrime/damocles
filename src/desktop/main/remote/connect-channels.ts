import {
  MAX_HOST_INPUT_LENGTH,
  MAX_HOST_NAME_LENGTH,
  MAX_PROMPT_ANSWER_LENGTH,
  MAX_REMOTE_PATH_LENGTH,
  OVERLAY_CHANNELS,
  type ConnectStartResult,
  type ConnectTarget,
  type HostParseResult,
  type HostRun,
  type InstallFolderResult,
  type LingerResult,
  type NameCheck,
  type PasswordlessResult,
  type RemoteBrowseResult,
  type RemoteHostEntry,
  type RemovalInfo,
  type RemoveServerOptions,
  type RemoveServerResult,
  type HostSettingChange,
  HOST_SWITCH_KEYS,
} from '../../preload/overlay-channels';
import { isHostTone } from '../../../shared/host-tones';
import { PERMISSION_MODES, type PermissionMode } from '../../../shared/types/settings';
import { isCredentialHost } from './host-store';
import { parseHostEntries } from '../overlay';

// What the Connect dialog may ask; every id is resolved against main's own lists by the implementation.
export interface ConnectActions {
  checkName(name: string, hostId: string | undefined): NameCheck;
  rename(hostId: string, name: string): Promise<NameCheck>;
  parse(input: string): HostParseResult;
  start(target: ConnectTarget): Promise<ConnectStartResult>;
  answer(attemptId: string, promptId: string, answer: string | null, remember: boolean): void;
  cancel(attemptId: string): void;
  browse(hostId: string, path: string | undefined): Promise<RemoteBrowseResult>;
  pickFolder(hostId: string, path: string): Promise<{ readonly projectKey: string }>;
  runs(hostId: string): Promise<readonly HostRun[]>;
  killRun(hostId: string, runId: string): Promise<void>;
  openRun(hostId: string, runId: string): Promise<void>;
  showLog(hostId: string): Promise<void>;
  setInstallFolder(hostId: string, folder: string | null): Promise<InstallFolderResult>;
  copyHostKeyCommand(hostId: string): Promise<void>;
  allowBackground(hostId: string): Promise<LingerResult>;
  entries(): readonly RemoteHostEntry[];
  setSetting(hostId: string, change: HostSettingChange): Promise<void>;
  revokeCredentialHost(hostId: string, credentialHost: string): Promise<void>;
  setUpPasswordless(hostId: string): Promise<PasswordlessResult>;
  removalInfo(hostId: string): Promise<RemovalInfo>;
  removeServer(hostId: string, options: RemoveServerOptions): Promise<RemoveServerResult>;
  retryRemoval(hostId: string): Promise<RemoveServerResult>;
  forget(hostId: string): Promise<void>;
  openSettings(hostId: string): void;
}

export interface ConnectOverlay {
  handleWhileOpen<T>(channel: string, isOpen: () => boolean, handler: (...args: unknown[]) => T | Promise<T>): void;
  isOpen(kind: 'connect' | 'closeRemote' | 'settings'): boolean;
}

// Host and attempt ids main issued, prompt ids and run ids: one bounded token.
const MAX_TOKEN_LENGTH = 128;
// A name as typed, before trimming; the host store's rule bounds the trimmed name.
const MAX_TYPED_NAME_LENGTH = MAX_HOST_NAME_LENGTH * 8;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A call's fields when it holds exactly the required keys and some of the optional ones, else undefined. */
export function exactFields(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = Object.keys(raw);
  if (!required.every((key) => Object.hasOwn(raw, key)) || !keys.every((key) => required.includes(key) || optional.includes(key))) return undefined;
  return raw;
}

const isToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;
const isBounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0');
const isPath = (value: unknown): value is string => isBounded(value, MAX_REMOTE_PATH_LENGTH) && value.length > 0;

function malformed(channel: string): Error {
  return new Error(`Malformed ${channel} call from the overlay`);
}

const TARGET_OSES: readonly unknown[] = ['win32', 'darwin', 'linux'];

/** A Settings > Remote hosts change, rebuilt: one known key with a value of its type. */
export function parseHostSettingChange(raw: unknown): HostSettingChange | undefined {
  const change = exactFields(raw, ['key', 'value']);
  if (!change) return undefined;
  const { key, value } = change;
  if (key === 'color') return value === null || isHostTone(value) ? { key, value } : undefined;
  if (key === 'defaultPermissionMode') return value === null || (PERMISSION_MODES as readonly unknown[]).includes(value) ? { key, value: value as PermissionMode | null } : undefined;
  if (key === 'osOverride') return value === null || TARGET_OSES.includes(value) ? { key, value: value as 'win32' | 'darwin' | 'linux' | null } : undefined;
  if ((HOST_SWITCH_KEYS as readonly unknown[]).includes(key) && typeof value === 'boolean') return { key: key as (typeof HOST_SWITCH_KEYS)[number], value };
  return undefined;
}

/** A connect.start target, rebuilt: a saved host's id, or an alias or "+ New host" input with the name to save it under. */
export function parseConnectTarget(raw: unknown): ConnectTarget | undefined {
  const call = exactFields(raw, ['target']);
  const target = call?.['target'];
  if (exactFields(target, ['hostId']) && isToken((target as Record<string, unknown>)['hostId'])) return { hostId: (target as Record<string, string>)['hostId']! };
  const alias = exactFields(target, ['alias', 'name']);
  if (alias && isBounded(alias['alias'], MAX_HOST_INPUT_LENGTH) && alias['alias'] !== '' && isBounded(alias['name'], MAX_TYPED_NAME_LENGTH)) return { alias: alias['alias'], name: alias['name'] };
  const input = exactFields(target, ['input', 'name']);
  if (input && isBounded(input['input'], MAX_HOST_INPUT_LENGTH) && isBounded(input['name'], MAX_TYPED_NAME_LENGTH)) return { input: input['input'], name: input['name'] };
  return undefined;
}

/**
 * The Connect dialog's channels on the overlay page, each answering closed unless a connect request is open (those onHosts
 * registers also while a settings request is open); every payload is rebuilt field by field and a malformed one rejects.
 */
export function registerConnectChannels(overlay: ConnectOverlay, actions: ConnectActions): void {
  const open = (): boolean => overlay.isOpen('connect');
  const on = <T>(channel: string, handler: (raw: unknown) => T | Promise<T>): void => overlay.handleWhileOpen(channel, open, (raw) => handler(raw));
  // the host card and Settings > Remote hosts share these
  const hostsOpen = (): boolean => overlay.isOpen('connect') || overlay.isOpen('settings');
  const onHosts = <T>(channel: string, handler: (raw: unknown) => T | Promise<T>): void => overlay.handleWhileOpen(channel, hostsOpen, (raw) => handler(raw));
  const hostCall = (raw: unknown, name: string): string => {
    const call = exactFields(raw, ['hostId']);
    if (!call || !isToken(call['hostId'])) throw malformed(name);
    return call['hostId'];
  };
  onHosts(OVERLAY_CHANNELS.hostsList, (raw) => {
    if (!exactFields(raw, [])) throw malformed('hosts.list');
    const entries = parseHostEntries(actions.entries());
    if (!entries) throw new Error('The saved hosts exceed the overlay bounds');
    return entries;
  });
  onHosts(OVERLAY_CHANNELS.hostsSetSetting, (raw) => {
    const call = exactFields(raw, ['hostId', 'change']);
    const change = call && parseHostSettingChange(call['change']);
    if (!call || !isToken(call['hostId']) || !change) throw malformed('hosts.setSetting');
    return actions.setSetting(call['hostId'], change);
  });
  onHosts(OVERLAY_CHANNELS.hostsRevokeCredential, (raw) => {
    const call = exactFields(raw, ['hostId', 'credentialHost']);
    if (!call || !isToken(call['hostId']) || !isCredentialHost(call['credentialHost'])) throw malformed('hosts.revokeCredential');
    return actions.revokeCredentialHost(call['hostId'], call['credentialHost']);
  });
  onHosts(OVERLAY_CHANNELS.hostsSetUpPasswordless, (raw) => actions.setUpPasswordless(hostCall(raw, 'hosts.setUpPasswordless')));
  onHosts(OVERLAY_CHANNELS.hostsRemovalInfo, (raw) => actions.removalInfo(hostCall(raw, 'hosts.removalInfo')));
  onHosts(OVERLAY_CHANNELS.hostsRemoveServer, (raw) => {
    const call = exactFields(raw, ['hostId', 'options']);
    const options = call && exactFields(call['options'], ['removeKey', 'disableLinger']);
    if (!call || !isToken(call['hostId']) || !options || typeof options['removeKey'] !== 'boolean' || typeof options['disableLinger'] !== 'boolean') throw malformed('hosts.removeServer');
    return actions.removeServer(call['hostId'], { removeKey: options['removeKey'], disableLinger: options['disableLinger'] });
  });
  onHosts(OVERLAY_CHANNELS.hostsRetryRemoval, (raw) => actions.retryRemoval(hostCall(raw, 'hosts.retryRemoval')));
  onHosts(OVERLAY_CHANNELS.hostsForget, (raw) => actions.forget(hostCall(raw, 'hosts.forget')));
  on(OVERLAY_CHANNELS.hostsOpenSettings, (raw) => actions.openSettings(hostCall(raw, 'hosts.openSettings')));
  onHosts(OVERLAY_CHANNELS.hostsCheckName, (raw) => {
    const call = exactFields(raw, ['name'], ['hostId']);
    if (!call || !isBounded(call['name'], MAX_TYPED_NAME_LENGTH) || (call['hostId'] !== undefined && !isToken(call['hostId']))) throw malformed('hosts.checkName');
    return actions.checkName(call['name'], call['hostId'] as string | undefined);
  });
  onHosts(OVERLAY_CHANNELS.hostsRename, (raw) => {
    const call = exactFields(raw, ['hostId', 'name']);
    if (!call || !isToken(call['hostId']) || !isBounded(call['name'], MAX_TYPED_NAME_LENGTH)) throw malformed('hosts.rename');
    return actions.rename(call['hostId'], call['name']);
  });
  on(OVERLAY_CHANNELS.hostsParse, (raw) => {
    const call = exactFields(raw, ['input']);
    if (!call || !isBounded(call['input'], MAX_HOST_INPUT_LENGTH)) throw malformed('hosts.parse');
    return actions.parse(call['input']);
  });
  on(OVERLAY_CHANNELS.connectStart, (raw) => {
    const target = parseConnectTarget(raw);
    if (!target) throw malformed('connect.start');
    return actions.start(target);
  });
  // a removal's prompt shows in Settings too
  onHosts(OVERLAY_CHANNELS.connectAnswer, (raw) => {
    const call = exactFields(raw, ['attemptId', 'promptId', 'answer'], ['remember']);
    const answer = call?.['answer'];
    const remember = call?.['remember'];
    if (!call || !isToken(call['attemptId']) || !isToken(call['promptId']) || !(answer === null || isBounded(answer, MAX_PROMPT_ANSWER_LENGTH)) || !(remember === undefined || typeof remember === 'boolean')) throw malformed('connect.answer');
    actions.answer(call['attemptId'], call['promptId'], answer as string | null, remember === true);
  });
  on(OVERLAY_CHANNELS.connectCancel, (raw) => {
    const call = exactFields(raw, ['attemptId']);
    if (!call || !isToken(call['attemptId'])) throw malformed('connect.cancel');
    actions.cancel(call['attemptId']);
  });
  onHosts(OVERLAY_CHANNELS.connectBrowse, (raw) => {
    const call = exactFields(raw, ['hostId'], ['path']);
    if (!call || !isToken(call['hostId']) || (call['path'] !== undefined && !isPath(call['path']))) throw malformed('connect.browse');
    return actions.browse(call['hostId'], call['path'] as string | undefined);
  });
  on(OVERLAY_CHANNELS.connectPickFolder, (raw) => {
    const call = exactFields(raw, ['hostId', 'path']);
    if (!call || !isToken(call['hostId']) || !isPath(call['path'])) throw malformed('connect.pickFolder');
    return actions.pickFolder(call['hostId'], call['path']);
  });
  on(OVERLAY_CHANNELS.hostsRuns, (raw) => {
    const call = exactFields(raw, ['hostId']);
    if (!call || !isToken(call['hostId'])) throw malformed('hosts.runs');
    return actions.runs(call['hostId']);
  });
  on(OVERLAY_CHANNELS.hostsKillRun, (raw) => {
    const call = exactFields(raw, ['hostId', 'runId']);
    if (!call || !isToken(call['hostId']) || !isToken(call['runId'])) throw malformed('hosts.killRun');
    return actions.killRun(call['hostId'], call['runId']);
  });
  on(OVERLAY_CHANNELS.hostsOpenRun, (raw) => {
    const call = exactFields(raw, ['hostId', 'runId']);
    if (!call || !isToken(call['hostId']) || !isToken(call['runId'])) throw malformed('hosts.openRun');
    return actions.openRun(call['hostId'], call['runId']);
  });
  onHosts(OVERLAY_CHANNELS.hostsShowLog, (raw) => {
    const call = exactFields(raw, ['hostId']);
    if (!call || !isToken(call['hostId'])) throw malformed('hosts.showLog');
    return actions.showLog(call['hostId']);
  });
  onHosts(OVERLAY_CHANNELS.hostsSetInstallFolder, (raw) => {
    const call = exactFields(raw, ['hostId', 'folder']);
    const folder = call?.['folder'];
    if (!call || !isToken(call['hostId']) || !(folder === null || isBounded(folder, MAX_REMOTE_PATH_LENGTH))) throw malformed('hosts.setInstallFolder');
    return actions.setInstallFolder(call['hostId'], folder as string | null);
  });
  // Allow background work shows on a host's card and on its rows of the close dialog
  overlay.handleWhileOpen(OVERLAY_CHANNELS.hostsAllowBackground, () => overlay.isOpen('connect') || overlay.isOpen('closeRemote'), (raw) => {
    const call = exactFields(raw, ['hostId']);
    if (!call || !isToken(call['hostId'])) throw malformed('hosts.allowBackground');
    return actions.allowBackground(call['hostId']);
  });
  on(OVERLAY_CHANNELS.hostsCopyHostKeyCommand, (raw) => {
    const call = exactFields(raw, ['hostId']);
    if (!call || !isToken(call['hostId'])) throw malformed('hosts.copyHostKeyCommand');
    return actions.copyHostKeyCommand(call['hostId']);
  });
}
