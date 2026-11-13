// Copy Permalink, Open File on Server and Open Commit on Server: main/forge/forge-host.ts builds the link on a
// managed server's origin and opens or copies it; this says what happened in a toast. Only main asks a question (D41), so the
// unpushed warning and its Push live here whichever menu, card or palette entry started the request.
import type { ForgeLinkRequest, ForgeLinkResult } from '../../shared/forge/links';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import type { IndexedNotifications } from './platform/notification-service';

export interface ForgeLinkCommandDeps {
  // opens or copies on a user's action; never returns the address
  readonly link: (request: ForgeLinkRequest) => Promise<ForgeLinkResult>;
  readonly notify: Pick<IndexedNotifications, 'show'>;
  // l10n/bundle.l10n*.json in main's language
  readonly t: (message: string, ...args: string[]) => string;
  // core's own text in main's language
  readonly render: (text: LocalizedText) => string;
  // the existing Push of the repository; true once it pushed
  readonly push: (repoId: string) => Promise<boolean>;
  readonly log: (line: string) => void;
}

function done(deps: ForgeLinkCommandDeps, request: ForgeLinkRequest, result: Extract<ForgeLinkResult, { kind: 'opened' | 'copied' }>): string {
  const { t } = deps;
  // a file by its repository path, a commit by its short hash
  const named = request.action === 'openCommit' ? t('Commit {0}', result.label) : result.label;
  const said = result.kind === 'copied'
    ? t('Copied the permalink to {0} on {1}.', named, result.serverName)
    : t('Opened {0} on {1} in your browser.', named, result.serverName);
  return result.dirty ? `${said} ${t('The file has uncommitted changes, so its lines may not match.')}` : said;
}

function unpushed(deps: ForgeLinkCommandDeps, request: ForgeLinkRequest, result: Extract<ForgeLinkResult, { kind: 'unpushed' }>): string {
  const { t } = deps;
  if (request.action !== 'openCommit') {
    return result.canPush
      ? t('This version of {0} is not on {1} yet, so its link would not open. Push it first.', result.label, result.serverName)
      : t('This version of {0} is not on {1} yet, so its link would not open. Push the branch that holds it first.', result.label, result.serverName);
  }
  return result.canPush
    ? t('Commit {0} is not on {1} yet, so its page would not open. Push it first.', result.label, result.serverName)
    : t('Commit {0} is not on {1} yet, so its page would not open. Push the branch that holds it first.', result.label, result.serverName);
}

/** Runs one link request a user started and tells them the outcome; an unpushed commit offers Push, then asks again. */
export async function runForgeLink(deps: ForgeLinkCommandDeps, request: ForgeLinkRequest): Promise<void> {
  let result: ForgeLinkResult;
  try {
    result = await deps.link(request);
  } catch (err) {
    deps.log(`[forge] the ${request.action} link failed: ${err instanceof Error ? err.message : String(err)}`);
    // core's own reason (a commit missing from the repository) says more than the generic text
    await deps.notify.show('error', err instanceof LocalizedError ? deps.render(err.text) : deps.t('Damocles could not make this link.'), []);
    return;
  }
  if (result.kind === 'unavailable') {
    await deps.notify.show('warning', result.reason, []);
    return;
  }
  if (result.kind === 'unpushed') {
    // without canPush, pushing HEAD's branch would not publish the commit, so no Push is offered
    const actions = result.canPush ? [deps.t('Push')] : [];
    const choice = await deps.notify.show('warning', unpushed(deps, request, result), actions);
    if (choice === 0 && await deps.push(request.repoId)) await runForgeLink(deps, request);
    return;
  }
  await deps.notify.show(result.dirty ? 'warning' : 'info', done(deps, request, result), []);
}
