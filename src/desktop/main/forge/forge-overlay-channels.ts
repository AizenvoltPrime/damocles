import type { CiChanged, ForgeChanged } from '../../preload/forge-channels';
import { FORGE_CHANNELS } from '../../preload/forge-channels';
import { MAX_OVERLAY_ID_LENGTH, OVERLAY_CHANNELS, type OverlayRequest } from '../../preload/overlay-channels';
import { MAX_CLONE_PASTE_CHARS, MAX_CLONE_QUERY_CHARS, type CloneAccountsView, type ClonePasteAnswer, type CloneSearchAnswer, type CloneSource, type CloneStartAnswer } from '../../../shared/forge/clone';
import type { HostDefaultsView } from '../../../shared/forge/bindings';
import type { CiAction, CiStatusView, CiTarget } from '../../../shared/forge/ci';
import { isCiAction, parseCiTarget } from './forge-host';
import { MAX_OWNER_VALUE_CHARS, MAX_REPOSITORY_NAME_CHARS, type FlowStart, type PublishOwnersAnswer, type PublishVisibility } from '../../../shared/forge/publish';
import { MAX_BRANCH_NAME_CHARS, type BranchNameCheck } from '../../../shared/forge/protected-push';
import { isPublishVisibility } from './publish-dialogs';

export type ClonePickerRequest = Extract<OverlayRequest, { kind: 'cloneFromAccount' }>;

// What Settings > Remote hosts > Default accounts, the ask-once dialog's sign-in and the CI job list may ask of
// main/forge/forge-host.ts and main/forge/job-log-tabs.ts.
export interface ForgeOverlayActions {
  hostDefaults(authorityKey: string): Promise<HostDefaultsView>;
  // false: not saved
  setHostDefault(authorityKey: string, serverId: string, accountId: string | null): Promise<boolean>;
  openAccounts(target: { readonly serverId?: string; readonly signIn?: boolean }): Promise<void>;
  // returns the unsubscribe
  onChanged(listener: (changed: ForgeChanged) => void): () => void;
  // the job list: its repository's CI read now, actions, Open log and Open on server
  pipeline(repoId: string): Promise<CiStatusView | null>;
  jobAction(repoId: string, target: CiTarget, action: CiAction): Promise<boolean>;
  jobLogOpen(repoId: string, jobId: number): Promise<void>;
  openOnServer(repoId: string, target: CiTarget): Promise<string | null>;
  // returns the unsubscribe
  onCiChanged(listener: (changed: CiChanged) => void): () => void;
  // the clone picker: accounts, one account's section, a pasted address's row, and Enter
  cloneAccounts(): Promise<CloneAccountsView>;
  // picker: the open picker's request, which owns the search
  cloneSearch(picker: ClonePickerRequest, accountId: string, query: string, requestId: number): Promise<CloneSearchAnswer>;
  clonePaste(text: string): Promise<ClonePasteAnswer>;
  cloneStart(picker: ClonePickerRequest, source: CloneSource): Promise<CloneStartAnswer>;
  // the Publish and fork dialogs: each starts its flow, whose steps follow on the dialog's state pushes
  publishSubmit(requestId: string, owner: string, name: string, visibility: PublishVisibility): FlowStart;
  forkStart(requestId: string): FlowStart;
  // the Publish dialog's per-account organizations or groups
  publishOwners(requestId: string, accountId: string): Promise<PublishOwnersAnswer>;
  // the protected-branch dialog: a name's check, and Push to a New Branch, whose steps follow on the dialog's state pushes
  protectedCheckName(requestId: string, name: string): Promise<BranchNameCheck>;
  protectedPush(requestId: string, name: string): FlowStart;
}

export interface ForgeOverlay {
  handleWhileOpen<T>(channel: string, isOpen: () => boolean, handler: (...args: unknown[]) => T | Promise<T>): void;
  isOpen(kind: 'settings' | 'pipeline' | 'cloneFromAccount' | 'forgePublish' | 'forgeFork' | 'forgeProtectedBranch'): boolean;
  openRequestOf<K extends 'pipeline' | 'cloneFromAccount' | 'forgePublish' | 'forgeFork' | 'forgeProtectedBranch'>(kind: K): Extract<OverlayRequest, { kind: K }> | undefined;
  send(channel: string, payload: unknown): void;
}

// the call's own fields: every required one and no other than the optional ones
function exactFields(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  return required.every((key) => Object.hasOwn(record, key)) && keys.every((key) => required.includes(key) || optional.includes(key)) ? record : undefined;
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_OVERLAY_ID_LENGTH;

function malformed(channel: string): Error {
  return new Error(`Malformed ${channel} request from the overlay`);
}

/**
 * The forge channels on one window's overlay: the settings modal's, each answering closed unless the modal is open, and the
 * job list's, each answering closed unless a job list of the call's repository is open. Every payload is rebuilt field by
 * field, and main's forge host checks the ids against its own records. Returns the unsubscribe of the change pushes.
 */
export function registerForgeOverlayChannels(overlay: ForgeOverlay, actions: ForgeOverlayActions): () => void {
  const open = (): boolean => overlay.isOpen('settings');
  overlay.handleWhileOpen(FORGE_CHANNELS.hostDefaults, open, (raw) => {
    const call = exactFields(raw, ['authorityKey']);
    if (!call || !isId(call['authorityKey'])) throw malformed('forge.hostDefaults');
    return actions.hostDefaults(call['authorityKey']);
  });
  overlay.handleWhileOpen(FORGE_CHANNELS.setHostDefault, open, (raw) => {
    const call = exactFields(raw, ['authorityKey', 'serverId', 'accountId']);
    if (!call || !isId(call['authorityKey']) || !isId(call['serverId']) || (call['accountId'] !== null && !isId(call['accountId']))) throw malformed('forge.setHostDefault');
    return actions.setHostDefault(call['authorityKey'], call['serverId'], call['accountId'] as string | null);
  });
  overlay.handleWhileOpen(FORGE_CHANNELS.openAccounts, open, (raw) => {
    const call = exactFields(raw, [], ['serverId', 'signIn']);
    const serverId = call?.['serverId'];
    if (!call || (serverId !== undefined && !isId(serverId)) || (call['signIn'] !== undefined && call['signIn'] !== true)) throw malformed('forge.openAccounts');
    return actions.openAccounts({ ...(serverId !== undefined ? { serverId: serverId as string } : {}), ...(call['signIn'] === true ? { signIn: true } : {}) });
  });

  // the job list answers only for the repository it shows; isOpen is checked again against the call's repoId
  const pipelineOpen = (): boolean => overlay.isOpen('pipeline');
  const shownRepo = (raw: unknown, channel: string): string => {
    const repoId = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['repoId'] : undefined;
    if (!isId(repoId)) throw malformed(channel);
    if (overlay.openRequestOf('pipeline')?.repoId !== repoId) throw new Error(`${channel} names a repository the job list does not show`);
    return repoId;
  };
  overlay.handleWhileOpen(FORGE_CHANNELS.ciStatus, pipelineOpen, (raw) => {
    if (!exactFields(raw, ['repoId'])) throw malformed('forge.ciStatus');
    return actions.pipeline(shownRepo(raw, 'forge.ciStatus'));
  });
  overlay.handleWhileOpen(FORGE_CHANNELS.jobAction, pipelineOpen, (raw) => {
    const call = exactFields(raw, ['repoId', 'target', 'action']);
    const target = parseCiTarget(call?.['target']);
    if (!call || !target || !isCiAction(call['action'])) throw malformed('forge.jobAction');
    return actions.jobAction(shownRepo(raw, 'forge.jobAction'), target, call['action']);
  });
  overlay.handleWhileOpen(FORGE_CHANNELS.jobLogOpen, pipelineOpen, (raw) => {
    const call = exactFields(raw, ['repoId', 'jobId']);
    const jobId = call?.['jobId'];
    if (!call || typeof jobId !== 'number' || !Number.isSafeInteger(jobId) || jobId < 1) throw malformed('forge.jobLogOpen');
    return actions.jobLogOpen(shownRepo(raw, 'forge.jobLogOpen'), jobId);
  });
  overlay.handleWhileOpen(FORGE_CHANNELS.openOnServer, pipelineOpen, (raw) => {
    const call = exactFields(raw, ['repoId', 'target']);
    const target = parseCiTarget(call?.['target']);
    if (!call || !target) throw malformed('forge.openOnServer');
    return actions.openOnServer(shownRepo(raw, 'forge.openOnServer'), target);
  });

  // the clone picker's: answered only while it is open; keys and pasted text go to core, which never trusts them
  const cloneOpen = (): boolean => overlay.isOpen('cloneFromAccount');
  const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
  overlay.handleWhileOpen(FORGE_CHANNELS.cloneAccounts, cloneOpen, (raw) => {
    if (!exactFields(raw, [])) throw malformed('forge.cloneAccounts');
    return actions.cloneAccounts();
  });
  overlay.handleWhileOpen(FORGE_CHANNELS.cloneSearch, cloneOpen, (raw) => {
    const call = exactFields(raw, ['accountId', 'query', 'requestId']);
    const requestId = call?.['requestId'];
    const picker = overlay.openRequestOf('cloneFromAccount');
    if (!call || !picker || !isId(call['accountId']) || !isText(call['query'], MAX_CLONE_QUERY_CHARS) || typeof requestId !== 'number' || !Number.isSafeInteger(requestId) || requestId < 0) throw malformed('forge.cloneSearch');
    return actions.cloneSearch(picker, call['accountId'], call['query'], requestId);
  });
  overlay.handleWhileOpen(FORGE_CHANNELS.clonePaste, cloneOpen, (raw) => {
    const call = exactFields(raw, ['text']);
    if (!call || !isText(call['text'], MAX_CLONE_PASTE_CHARS)) throw malformed('forge.clonePaste');
    return actions.clonePaste(call['text']);
  });
  overlay.handleWhileOpen(FORGE_CHANNELS.cloneStart, cloneOpen, (raw) => {
    const row = exactFields(raw, ['accountId', 'key']);
    const paste = row ? undefined : exactFields(raw, ['pasteText']);
    const source: CloneSource | undefined = row && isId(row['accountId']) && isId(row['key'])
      ? { accountId: row['accountId'], key: row['key'] }
      : paste && isText(paste['pasteText'], MAX_CLONE_PASTE_CHARS) ? { pasteText: paste['pasteText'] } : undefined;
    const picker = overlay.openRequestOf('cloneFromAccount');
    if (!source || !picker) throw malformed('forge.cloneStart');
    return actions.cloneStart(picker, source);
  });

  // the Publish and fork dialogs': answered only for the open dialog of the call's requestId
  overlay.handleWhileOpen(FORGE_CHANNELS.publishSubmit, () => overlay.isOpen('forgePublish'), (raw) => {
    const call = exactFields(raw, ['requestId', 'owner', 'name', 'visibility']);
    const { requestId, owner, name, visibility } = call ?? {};
    if (!call || !isId(requestId) || !isText(owner, MAX_OWNER_VALUE_CHARS) || !isText(name, MAX_REPOSITORY_NAME_CHARS * 4) || !isPublishVisibility(visibility)) throw malformed('forge.publishSubmit');
    if (overlay.openRequestOf('forgePublish')?.dialog.requestId !== requestId) throw new Error('forge.publishSubmit names a Publish dialog that is not open');
    return actions.publishSubmit(requestId, owner, name, visibility);
  });
  overlay.handleWhileOpen(FORGE_CHANNELS.forkStart, () => overlay.isOpen('forgeFork'), (raw) => {
    const call = exactFields(raw, ['requestId']);
    const requestId = call?.['requestId'];
    if (!call || !isId(requestId)) throw malformed('forge.forkStart');
    if (overlay.openRequestOf('forgeFork')?.dialog.requestId !== requestId) throw new Error('forge.forkStart names a fork dialog that is not open');
    return actions.forkStart(requestId);
  });

  overlay.handleWhileOpen(FORGE_CHANNELS.publishOwners, () => overlay.isOpen('forgePublish'), (raw) => {
    const call = exactFields(raw, ['requestId', 'accountId']);
    const { requestId, accountId } = call ?? {};
    if (!call || !isId(requestId) || !isId(accountId)) throw malformed('forge.publishOwners');
    if (overlay.openRequestOf('forgePublish')?.dialog.requestId !== requestId) throw new Error('forge.publishOwners names a Publish dialog that is not open');
    return actions.publishOwners(requestId, accountId);
  });

  // the protected-branch dialog's: answered only for the open dialog of the call's requestId
  const protectedCall = (raw: unknown, channel: string): { readonly requestId: string; readonly name: string } => {
    const call = exactFields(raw, ['requestId', 'name']);
    const { requestId, name } = call ?? {};
    if (!call || !isId(requestId) || typeof name !== 'string' || name.length > MAX_BRANCH_NAME_CHARS) throw malformed(channel);
    if (overlay.openRequestOf('forgeProtectedBranch')?.dialog.requestId !== requestId) throw new Error(`${channel} names a protected-branch dialog that is not open`);
    return { requestId, name };
  };
  overlay.handleWhileOpen(FORGE_CHANNELS.protectedCheckName, () => overlay.isOpen('forgeProtectedBranch'), (raw) => {
    const { requestId, name } = protectedCall(raw, 'forge.protectedCheckName');
    return actions.protectedCheckName(requestId, name);
  });
  overlay.handleWhileOpen(FORGE_CHANNELS.protectedPush, () => overlay.isOpen('forgeProtectedBranch'), (raw) => {
    const { requestId, name } = protectedCall(raw, 'forge.protectedPush');
    return actions.protectedPush(requestId, name);
  });

  // OVERLAY_REQUEST_PUSHES holds them for a request not shown yet
  const unsubscribe = [
    actions.onChanged((changed) => overlay.send(OVERLAY_CHANNELS.forgeChanged, changed)),
    actions.onCiChanged((changed) => {
      if (overlay.openRequestOf('pipeline')?.repoId === changed.repoId) overlay.send(OVERLAY_CHANNELS.forgeCiChanged, changed);
    }),
  ];
  return () => unsubscribe.forEach((dispose) => dispose());
}
