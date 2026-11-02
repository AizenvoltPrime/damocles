// Ported from Visual Studio Code's incrementFileName, `simple` mode (src/vs/workbench/contrib/files/browser/fileActions.ts),
// MIT License, Copyright (c) Microsoft Corporation; see THIRD-PARTY-NOTICES.md.
import * as path from 'node:path';

// Constants.MAX_SAFE_SMALL_INTEGER in VS Code's uint.ts
const MAX_SAFE_SMALL_INTEGER = 1 << 30;
const COPY_SUFFIX = /^(.+ copy)( \d+)?$/;

/** The next name Keep both tries: `app.ts` becomes `app copy.ts`, then `app copy 2.ts`; a folder's name keeps any dot. */
export function incrementFileName(name: string, isFolder: boolean): string {
  let namePrefix = name;
  let extSuffix = '';
  if (!isFolder) {
    extSuffix = path.posix.extname(name);
    namePrefix = path.posix.basename(name, extSuffix);
  }
  if (COPY_SUFFIX.test(namePrefix)) {
    return namePrefix.replace(COPY_SUFFIX, (_match, g1: string, g2: string | undefined) => {
      const number = g2 ? parseInt(g2, 10) : 1;
      if (number === 0) return g1;
      return number < MAX_SAFE_SMALL_INTEGER ? `${g1} ${number + 1}` : `${g1}${g2 ?? ''} copy`;
    }) + extSuffix;
  }
  return `${namePrefix} copy${extSuffix}`;
}
