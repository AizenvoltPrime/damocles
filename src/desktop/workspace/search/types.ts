import type { SearchFileKey, SearchQuery, SearchRange } from '../../../shared/text-search';
import type { KeptText } from './replace';

export type TextEncoding = 'utf8' | 'utf16le' | 'utf16be';

export interface DiskState {
  readonly exists: boolean;
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha256: string;
}

export interface ProjectFileLocation {
  // the file's native realpath
  readonly path: string;
  readonly projectKey: string;
  readonly relativePath: string;
}

export type ClosedFileRead =
  | {
      readonly kind: 'text';
      readonly location: ProjectFileLocation;
      // decoded, with the line endings the file has
      readonly text: string;
      readonly eol: '\n' | '\r\n';
      readonly encoding: TextEncoding;
      readonly bom: boolean;
      readonly disk: DiskState;
    }
  | { readonly kind: 'readOnly' | 'missing' };

export type ClosedFileWrite = { readonly ok: true } | { readonly ok: false; readonly reason: 'openInEditor' | 'conflict' | 'failed'; readonly message?: string };

// The shown folder of the window's selected project: ripgrep's working directory and only path.
export interface SearchFolder {
  readonly projectKey: string;
  readonly fsPath: string;
}

// A match main keeps for replace, dismiss and copy: its file, its text at its range as keepMatchText keeps it, and the
// buffer it came from.
export interface RecordedMatch {
  readonly file: SearchFileKey;
  readonly range: SearchRange;
  readonly text: KeptText;
  // the first line's preview, for Copy
  readonly line: string;
  readonly documentId?: string;
}

export interface RecordedSearch {
  readonly searchId: number;
  // as the user typed it, with smart case applied
  readonly query: SearchQuery;
  readonly folder: SearchFolder;
  readonly matches: ReadonlyMap<number, RecordedMatch>;
}
