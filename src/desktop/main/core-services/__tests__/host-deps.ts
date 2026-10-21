import * as path from 'node:path';
import type { Disposable } from '../../../../platform/disposable';
import type { HostServicesDeps, HostUi } from '../host-services';

const none = (): Disposable => ({ dispose: () => undefined });
const refuse = (): never => {
  throw new Error('not in this test');
};

/** What HostServices needs besides main's services that these tests do not exercise: paths, logs, language, power and UI. */
export function hostExtras(overrides: { readonly ui?: Partial<HostUi>; readonly endedCores?: HostServicesDeps['endedCores'] } = {}): Pick<HostServicesDeps, 'paths' | 'logs' | 'endedCores' | 'worktreeRecords' | 'language' | 'power' | 'ui'> {
  const dist = (name: string): string => path.resolve('/app/dist', name);
  return {
    paths: {
      resourceRoot: path.resolve('/app'),
      unpackedRoot: path.resolve('/app'),
      workers: {
        compass: dist('compass-worker.js'),
        usageStats: dist('usage-stats-worker.js'),
        sentinel: dist('sentinel.js'),
        processLauncher: dist('process-launcher-worker.js'),
        memoryIntegrity: dist('memory-integrity-worker.js'),
        sessionMetaIndex: dist('session-meta-index-worker.js'),
        voiceExtract: dist('voice-extract-worker.js'),
      },
      watchWorker: dist('watch-worker.js'),
      askpass: { askpass: dist('askpass/askpass.sh'), sshAskpass: dist('askpass/ssh-askpass.sh'), node: path.resolve('/app/node'), main: dist('askpass-main.js') },
    },
    logs: { dir: path.resolve('/userData/logs'), echo: false },
    endedCores: overrides.endedCores ?? [],
    worktreeRecords: [],
    language: { current: () => 'en', onDidChange: none },
    power: { onSuspend: none, onResume: none },
    ui: {
      showLog: refuse,
      trash: refuse,
      ask: refuse,
      askpass: refuse,
      worktrees: {
        reviewSetup: refuse,
        runSetup: refuse,
        showSetupTerminal: refuse,
        stopSetup: refuse,
        confirmHandOff: refuse,
        showRefusal: refuse,
        showApplyConflicts: refuse,
      },
      ...overrides.ui,
    },
  };
}
