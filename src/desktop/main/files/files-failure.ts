import { LocalizedError, type LocalizedText } from '../../../shared/localized-text';
import { visibleText } from '../../../shared/visible-text';
import type { EditorOpenResult, FilesDeleteResult, FilesListResult, FilesMutationResult } from '../../preload/shell-channels';
import type { ConfineRefusal } from '../../local-services/confine';

export type FilesAction = 'create' | 'rename' | 'delete' | 'copyPath' | 'reveal' | 'list' | 'open';

// A user's open keeps its confinement's refusal (share: a link to a network share or WSL path; oldDaemon: a link out of the
// project on a daemon without files.links).
export type FilesOpenResult = EditorOpenResult | ConfineRefusal;

type FilesResult = FilesMutationResult | FilesDeleteResult | FilesListResult | FilesOpenResult;

type Translate = (message: string, ...args: string[]) => string;

export type FilesFailed = { readonly ok: false; readonly reason: 'failed'; readonly message: string };

/**
 * A Files action that throws resolves as one that failed, so its failure is reported the same way: a LocalizedError in the
 * user's language (render), any other error as written.
 */
export async function settleFilesAction<T extends FilesResult>(run: () => Promise<T>, log: (line: string) => void, render: (text: LocalizedText) => string): Promise<T | FilesFailed> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[files] ${message}`);
    return { ok: false, reason: 'failed', message: err instanceof LocalizedError ? render(err.text) : message };
  }
}

/**
 * The one error toast a failed Files action shows, naming the entry and the reason, as VS Code's explorer shows an error
 * notification; undefined for a success and for a cancel, which the user chose. hostName: the remote host holding the entry,
 * asked only for a refusal of its daemon; render: a failure's own words (error) in the user's language.
 */
export function filesFailureMessage(t: Translate, render: (text: LocalizedText) => string, action: FilesAction, rawName: string, hostName: () => string, result: FilesResult, rawNewName: string = rawName): string | undefined {
  if (result.ok || result.reason === 'cancelled') return undefined;
  const name = visibleText(rawName);
  const newName = visibleText(rawNewName);
  const refusal = 'refusal' in result ? result.refusal : undefined;
  const error = 'error' in result ? result.error : undefined;
  const reason = result.reason === 'exists' ? t('A file or folder named {0} already exists there.', newName)
    : result.reason === 'invalidName' ? t('{0} is not a valid file or folder name.', newName)
      : result.reason === 'sessionFile' ? t('Chat session files are kept there, and only Damocles changes them.')
        : refusal === 'share' ? t('A link on its path leads to a network share or WSL path.')
          : refusal === 'oldDaemon' ? t('Update the Damocles server on {0} to open links that lead outside the project.', visibleText(hostName()))
            : result.reason === 'outside' ? t('That location is outside the project.')
              : result.reason === 'missing' ? t('It is no longer there.')
                : error !== undefined ? visibleText(render(error))
                  : ('message' in result ? visibleText(result.message) : undefined) ?? t('The file system refused it.');
  switch (action) {
    case 'create': return t('Damocles could not create {0}: {1}', name, reason);
    case 'rename': return t('Damocles could not rename {0}: {1}', name, reason);
    case 'delete': return t('Damocles could not delete {0}: {1}', name, reason);
    case 'copyPath': return t('Damocles could not copy the path of {0}: {1}', name, reason);
    case 'reveal': return t('Damocles could not reveal {0}: {1}', name, reason);
    case 'list': return t('Damocles could not open the folder {0}: {1}', name, reason);
    case 'open': return t('Damocles could not open {0}: {1}', name, reason);
  }
}
