import type { HostRecord } from './remote/host-store';
import type { Translate } from './trust-store';

/** Show log's first tab: what the host's transport wrote to stderr, titled by the program that wrote it. */
export function transportOutputDocument(record: HostRecord, hostName: string, stderr: string, t: Translate): { readonly title: string; readonly text: string; readonly fileName: string } {
  switch (record.kind) {
    case 'ssh':
      return { title: t('{0}: {1}', hostName, t('ssh output')), text: stderr === '' ? t('ssh wrote nothing.') : stderr, fileName: 'ssh-output.log' };
    case 'wsl':
      return { title: t('{0}: {1}', hostName, t('wsl.exe output')), text: stderr === '' ? t('wsl.exe wrote nothing.') : stderr, fileName: 'wsl-output.log' };
    case 'container':
      return { title: t('{0}: {1}', hostName, t('{0} exec output', record.engine)), text: stderr === '' ? t('{0} exec wrote nothing.', record.engine) : stderr, fileName: 'container-output.log' };
  }
}
