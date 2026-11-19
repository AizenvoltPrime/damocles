/**
 * Why a file change carries no patch; its card says which instead of showing invented line numbers. binary: the content holds a NUL;
 * unreadable: the file could not be read; notAFile: a folder, FIFO or device, which is never opened.
 */
export type FilePatchOmitted = 'tooLarge' | 'binary' | 'unreadable' | 'notAFile';

/**
 * A file change's diff data, in a Write result's `details` and an Edit or Write approval: a unified patch
 * whose hunk headers hold the file's real line numbers, or the reason none was recorded. pi's own `edit`
 * records the same `patch` field.
 */
export type FilePatch = { patch: string } | { patchOmitted: FilePatchOmitted };

/** A Write result's `details`: the overwrite's patch, or the marker that the write created its file. */
export type WriteDetails = FilePatch | { created: true };
