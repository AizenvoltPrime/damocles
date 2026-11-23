// Every path a theme store or the theme service reads is judged from its store's folder (docs/invariants.md "Platform boundary and shared stores").
import { checkConfigPath, ConfigReadRefused, ConfigWriteRefused, noticeRefusedConfigRead, type ConfigNotices } from '../config/local-config-path';

export interface ThemePathRule {
  // the store's folder, the base every path is judged from: ~/.damocles/themes, or ~/.damocles for the user settings file
  readonly root: string;
  // throws ConfigReadRefused, after telling the user once per file, for a path below the root that links off the root's share
  readable(file: string): Promise<void>;
  // throws ConfigWriteRefused for such a path; for a write, a rename or a delete
  writable(file: string): Promise<void>;
}

/** The rule of the store at `root`; a check that rejects (a loop, a drive that does not answer) rejects the read or write too. */
export function createThemePathRule(root: string, notices?: ConfigNotices): ThemePathRule {
  return {
    root,
    async readable(file) {
      if ((await checkConfigPath(root, file)) === 'ok') return;
      noticeRefusedConfigRead(file, notices);
      throw new ConfigReadRefused(file);
    },
    async writable(file) {
      if ((await checkConfigPath(root, file)) !== 'ok') throw new ConfigWriteRefused(file);
    },
  };
}
