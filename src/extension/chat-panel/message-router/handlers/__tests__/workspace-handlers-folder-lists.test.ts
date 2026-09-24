import { describe, it, expect, vi } from 'vitest';
import { createWorkspaceHandlers } from '../workspace-handlers';
import type { FolderTarget } from '../../../../workspace-folders/folder-registry';
import type { ExtensionToWebviewMessage } from '../../../../../shared/types/messages';

vi.mock('vscode', () => ({
  window: { showInformationMessage: vi.fn() },
  workspace: {},
  Uri: { file: (p: string) => ({ fsPath: p }) },
  l10n: { t: (s: string) => s },
}));
vi.mock('../../../../logger', () => ({ log: vi.fn() }));

const target = (fsPath: string): FolderTarget => ({ key: fsPath, fsPath, name: fsPath, label: fsPath, projectScope: true });
const A = target('/a');
const B = target('/b');

/** A panel on A whose folder lists resolve only when released, so a switch can land in between. */
function harness() {
  const instance = { folder: A };
  const posted: ExtensionToWebviewMessage[] = [];
  let release!: () => void;
  const listed = new Promise<void>((resolve) => { release = resolve; });
  const workspaceManager = {
    workspaceFilesMessage: async (folder: FolderTarget) => {
      await listed;
      return { type: 'workspaceFiles', files: [{ relativePath: `${folder.key}/x.ts`, isDirectory: false }] };
    },
    customSlashCommandsMessage: async () => {
      await listed;
      return { type: 'customSlashCommands', commands: [] };
    },
  };
  const deps = {
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message),
    getPanels: () => new Map([['p1', instance]]),
    workspaceManager,
  } as unknown as Parameters<typeof createWorkspaceHandlers>[0];
  const ctx = { host: {}, panelId: 'p1', folder: A } as never;
  return { handlers: createWorkspaceHandlers(deps), ctx, instance, posted, release };
}

describe.each([
  ['requestWorkspaceFiles', 'workspaceFiles'],
  ['requestCustomSlashCommands', 'customSlashCommands'],
] as const)('%s', (handler, messageType) => {
  it('posts the list for the folder the panel is still on', async () => {
    const h = harness();
    const running = h.handlers[handler]!({ type: handler } as never, h.ctx);
    h.release();
    await running;
    expect(h.posted.map((m) => m.type)).toEqual([messageType]);
  });

  it('drops a list that finishes after the panel switched folder', async () => {
    const h = harness();
    const running = h.handlers[handler]!({ type: handler } as never, h.ctx);
    h.instance.folder = B;
    h.release();
    await running;
    expect(h.posted).toEqual([]);
  });
});
