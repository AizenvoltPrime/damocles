export type ConfinedFile = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: 'outside' | 'missing' | 'failed' };

/** The host's rule for a file a renderer names inside a folder; core resolves such a file only through it. */
export interface FileConfinement {
  // relativePath: '/' separated. ok: the file's real path, which lies under the folder's real path.
  confineExisting(folder: string, relativePath: string): Promise<ConfinedFile>;
}
