/**
 * The settingsHost.rows key of a damocles.desktop.git.* setting: damocles.desktop.git.alwaysSignOff is gitAlwaysSignOff, and
 * damocles.desktop.git.blame.editorDecoration.enabled is gitBlameEditorDecorationEnabled.
 */
export const gitRowName = (key: string): string =>
  `git${key.slice('damocles.desktop.git.'.length).replace(/(?:^|\.)(\w)/g, (_match, letter: string) => letter.toUpperCase())}`;
