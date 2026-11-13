// The Publish and fork dialogs within the overlay's bounds: main builds them from core's answers, and every text a server
// or git gave is shown as text with its hidden characters escaped.
import type { ForkDialog, PublishAccount, PublishDialog, PublishNamespace } from '../../../shared/forge/publish';
import { MAX_OWNER_VALUE_CHARS, PUBLISH_VISIBILITIES } from '../../../shared/forge/publish';
import { MAX_BRANCH_NAME_CHARS, type ProtectedBranchDialog } from '../../../shared/forge/protected-push';
import { boundedLines, visibleText } from '../../../shared/visible-text';
import { MAX_OVERLAY_ID_LENGTH, MAX_OVERLAY_ITEMS, MAX_OVERLAY_LABEL_LENGTH, MAX_OVERLAY_TEXT_LENGTH, MAX_REMOTE_PATH_LENGTH, type OverlayRequest } from '../../preload/overlay-channels';

// up to ten pages of 100 organizations or groups per account (core/forge/publish.ts)
const MAX_OWNERS = 10 * MAX_OVERLAY_ITEMS;

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

/** A failure, reason or error line for a dialog: hidden characters escaped, cut to the overlay's text bound between whole characters. */
export function dialogText(text: string): string {
  return boundedLines(text, MAX_OVERLAY_TEXT_LENGTH);
}

function parseNamespace(namespace: PublishNamespace): PublishNamespace | undefined {
  const { value, kind, path, internal } = namespace;
  if (!isText(value, MAX_OWNER_VALUE_CHARS) || !isText(path, MAX_REMOTE_PATH_LENGTH)) return undefined;
  return { value, kind, path: visibleText(path), internal };
}

/** One account's listed organizations or groups for the dialog; undefined past the overlay's bounds. */
export function parseOwners(owners: readonly PublishNamespace[]): PublishNamespace[] | undefined {
  if (owners.length > MAX_OWNERS) return undefined;
  const parsed = owners.map(parseNamespace);
  return parsed.every((owner): owner is PublishNamespace => owner !== undefined && owner.kind !== 'personal') ? parsed : undefined;
}

function parseAccount(account: PublishAccount): PublishAccount | undefined {
  const { accountId, serverName, login, kind, personal } = account;
  if (!isText(accountId, MAX_OVERLAY_ID_LENGTH) || !isText(serverName, MAX_OVERLAY_LABEL_LENGTH) || !isText(login, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
  const own = parseNamespace(personal);
  if ((kind !== 'github' && kind !== 'gitlab') || !own || own.kind !== 'personal') return undefined;
  return { accountId, serverName: visibleText(serverName), login: visibleText(login), kind, personal: own };
}

/** The Publish dialog as an overlay request; undefined past the overlay's bounds or with owner values that are not unique. */
export function parsePublishRequest(dialog: PublishDialog): Extract<OverlayRequest, { kind: 'forgePublish' }> | undefined {
  const { requestId, project, branch, accounts, defaultOwner, defaultName } = dialog;
  if (!isText(requestId, MAX_OVERLAY_ID_LENGTH) || !isText(project, MAX_OVERLAY_LABEL_LENGTH) || !isText(branch, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
  if (accounts.length === 0 || accounts.length > MAX_OVERLAY_ITEMS || defaultName.length > MAX_OVERLAY_LABEL_LENGTH) return undefined;
  const parsed = accounts.map(parseAccount);
  if (!parsed.every((account): account is PublishAccount => account !== undefined)) return undefined;
  const values = parsed.map((account) => account.personal.value);
  if (new Set(values).size !== values.length || !values.includes(defaultOwner)) return undefined;
  return { kind: 'forgePublish', dialog: { requestId, project: visibleText(project), branch: visibleText(branch), accounts: parsed, defaultOwner, defaultName } };
}

/** The fork dialog as an overlay request; undefined past the overlay's bounds. */
export function parseForkRequest(dialog: ForkDialog): Extract<OverlayRequest, { kind: 'forgeFork' }> | undefined {
  const { requestId, serverName, kind, path, login, branch, remote, upstreamName, upstreamExists } = dialog;
  if (!isText(requestId, MAX_OVERLAY_ID_LENGTH) || (kind !== 'github' && kind !== 'gitlab') || typeof upstreamExists !== 'boolean') return undefined;
  if (![serverName, login, branch, remote, upstreamName].every((text) => isText(text, MAX_OVERLAY_LABEL_LENGTH)) || !isText(path, MAX_REMOTE_PATH_LENGTH)) return undefined;
  return {
    kind: 'forgeFork',
    dialog: { requestId, serverName: visibleText(serverName), kind, path: visibleText(path), login: visibleText(login), branch: visibleText(branch), remote, upstreamName, upstreamExists },
  };
}

/** The protected-branch dialog as an overlay request; undefined past the overlay's bounds. */
export function parseProtectedBranchRequest(dialog: ProtectedBranchDialog): Extract<OverlayRequest, { kind: 'forgeProtectedBranch' }> | undefined {
  const { requestId, branch, serverName, kind, login, remote, localBranch, unpushedCount, suggestedName } = dialog;
  if (!isText(requestId, MAX_OVERLAY_ID_LENGTH) || (kind !== 'github' && kind !== 'gitlab') || !Number.isSafeInteger(unpushedCount) || unpushedCount < 0) return undefined;
  if (![branch, serverName, login, remote, localBranch].every((text) => isText(text, MAX_OVERLAY_LABEL_LENGTH)) || suggestedName.length > MAX_BRANCH_NAME_CHARS) return undefined;
  return {
    kind: 'forgeProtectedBranch',
    dialog: { requestId, branch: visibleText(branch), serverName: visibleText(serverName), kind, login: visibleText(login), remote: visibleText(remote), localBranch: visibleText(localBranch), unpushedCount, suggestedName },
  };
}

/** Whether a submit's visibility is one the dialog offers. */
export const isPublishVisibility = (value: unknown): value is (typeof PUBLISH_VISIBILITIES)[number] => (PUBLISH_VISIBILITIES as readonly unknown[]).includes(value);
