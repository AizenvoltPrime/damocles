/** The settingsHost.rows key of a damocles.desktop.git.* setting: damocles.desktop.git.alwaysSignOff is gitAlwaysSignOff. */
export const gitRowName = (key: string): string => `git${key.charAt('damocles.desktop.git.'.length).toUpperCase()}${key.slice('damocles.desktop.git.'.length + 1)}`;
