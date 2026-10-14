import type { Component } from 'vue';
import { CopyPlus, GitBranchPlus, History, ShieldAlert, TriangleAlert } from 'lucide-vue-next';
import type { ScmRunRequest, ScmView } from '../../preload/scm-channels';
import type { ShellPlatform } from '../../preload/shell-channels';

// An empty or error state of a project's source control, shared by Source control and Repositories (D58: an untrusted
// project shows Source control's trust state there too).
export interface ScmStateCard {
  readonly id: 'untrusted' | 'gitMissing' | 'unsafe' | 'parent' | 'closed' | 'noRepository';
  readonly icon: Component;
  readonly tone: 'warning' | 'faint';
  readonly title?: string;
  readonly text: string;
  readonly primary: { readonly label: string; readonly run: () => unknown };
  // the prototype's outlined second action (Clone Repository on the no-repository card)
  readonly secondary?: { readonly label: string; readonly icon: Component; readonly run: () => unknown };
}

export interface ScmStateActions {
  readonly grantTrust: (projectKey: string) => unknown;
  readonly run: (request: ScmRunRequest) => unknown;
}

type Translate = (key: string, plural?: number) => string;

/** The card a project's view shows, as VS Code's SCM welcome views word them; none while it loads or has repositories open. */
export function scmStateCard(view: ScmView | undefined, projectKey: string | undefined, platform: ShellPlatform, t: Translate, act: ScmStateActions): ScmStateCard | undefined {
  if (!view || projectKey === undefined || view.state === 'loading') return undefined;
  const run = act.run;
  if (view.state === 'untrusted') {
    return { id: 'untrusted', icon: ShieldAlert, tone: 'warning', title: t('scm.state.untrusted.title'), text: t('scm.state.untrusted.text'), primary: { label: t('scm.state.untrusted.trust'), run: () => act.grantTrust(projectKey) } };
  }
  if (view.state === 'gitMissing') {
    const download = t(`scm.state.gitMissing.download.${platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux'}`);
    return { id: 'gitMissing', icon: TriangleAlert, tone: 'warning', text: t('scm.state.gitMissing.text'), primary: { label: download, run: () => run({ op: 'openGitDownload' }) } };
  }
  if (view.state === 'ready' && view.repos.length > 0) return undefined;
  if (view.unsafePaths.length > 0) {
    return { id: 'unsafe', icon: ShieldAlert, tone: 'warning', text: t('scm.state.unsafe.text', view.unsafePaths.length), primary: { label: t('scm.state.unsafe.manage'), run: () => run({ op: 'manageUnsafeRepositories', projectKey }) } };
  }
  if (view.parentCount > 0) {
    return { id: 'parent', icon: History, tone: 'faint', text: t('scm.state.parent.text', view.parentCount), primary: { label: t('scm.state.parent.open'), run: () => run({ op: 'openParentRepositories', projectKey }) } };
  }
  if (view.closedCount > 0) {
    return { id: 'closed', icon: History, tone: 'faint', text: t('scm.state.closed.text', view.closedCount), primary: { label: t('scm.state.closed.reopen', view.closedCount), run: () => run({ op: 'reopenClosed', projectKey }) } };
  }
  return {
    id: 'noRepository',
    icon: GitBranchPlus,
    tone: 'faint',
    text: t('scm.state.noRepository.text'),
    primary: { label: t('scm.state.noRepository.init'), run: () => run({ op: 'init', projectKey }) },
    secondary: { label: t('scm.state.noRepository.clone'), icon: CopyPlus, run: () => run({ op: 'clone', recursive: false }) },
  };
}
