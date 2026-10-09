import type { FilesDeleteResult, FilesListResult, FilesMutationResult } from '../../preload/shell-channels';

export type FilesAction = 'create' | 'rename' | 'delete' | 'copyPath' | 'reveal' | 'list';

type FilesResult = FilesMutationResult | FilesDeleteResult | FilesListResult;

type Translate = (message: string, ...args: string[]) => string;

export type FilesFailed = { readonly ok: false; readonly reason: 'failed'; readonly message: string };

/** A Files action that throws resolves as one that failed, so its failure is reported the same way. */
export async function settleFilesAction<T extends FilesResult>(run: () => Promise<T>, log: (line: string) => void): Promise<T | FilesFailed> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[files] ${message}`);
    return { ok: false, reason: 'failed', message };
  }
}

/**
 * The one error toast a failed Files action shows, naming the entry and the reason, as VS Code's explorer shows an error
 * notification; undefined for a success and for a cancel, which the user chose.
 */
export function filesFailureMessage(t: Translate, action: FilesAction, name: string, result: FilesResult, newName: string = name): string | undefined {
  if (result.ok || result.reason === 'cancelled') return undefined;
  const reason = result.reason === 'exists' ? t('A file or folder named {0} already exists there.', newName)
    : result.reason === 'invalidName' ? t('{0} is not a valid file or folder name.', newName)
      : result.reason === 'outside' ? t('That location is outside the project.')
        : result.reason === 'missing' ? t('It is no longer there.')
          : ('message' in result ? result.message : undefined) ?? t('The file system refused it.');
  switch (action) {
    case 'create': return t('Damocles could not create {0}: {1}', name, reason);
    case 'rename': return t('Damocles could not rename {0}: {1}', name, reason);
    case 'delete': return t('Damocles could not delete {0}: {1}', name, reason);
    case 'copyPath': return t('Damocles could not copy the path of {0}: {1}', name, reason);
    case 'reveal': return t('Damocles could not reveal {0}: {1}', name, reason);
    case 'list': return t('Damocles could not open the folder {0}: {1}', name, reason);
  }
}
