import type { DamoclesShellApi, ShellProject } from '../preload/shell-channels';
import { visibleText } from '@shared/visible-text';

type Translate = (key: string, values?: Record<string, unknown>) => string;

/**
 * Stop moving… on a project's paused move (docs/desktop-app.md "Locate"): abandons it once the user accepts the danger
 * confirmation naming where the moved chats stay and where the rest stay.
 */
export async function confirmStopMoving(api: Pick<DamoclesShellApi, 'requestOverlay' | 'abandonRelocation'>, project: ShellProject, t: Translate): Promise<void> {
  const relocation = project.relocation;
  if (relocation?.state !== 'paused' || relocation.abandonable !== true) return;
  const to = visibleText(relocation.to);
  const answer = await api.requestOverlay({
    kind: 'confirm',
    title: t('projects.locate.abandonTitle', { name: visibleText(project.name) }),
    message: t('projects.locate.abandonMessage', { from: visibleText(project.fsPath), to }),
    detail: { label: t('projects.locate.abandonFolder'), text: to },
    confirmLabel: t('projects.locate.abandonConfirm'),
    cancelLabel: t('projects.locate.abandonCancel'),
    danger: true,
  });
  if (answer.kind === 'confirm' && answer.confirmed) await api.abandonRelocation(project.key);
}
