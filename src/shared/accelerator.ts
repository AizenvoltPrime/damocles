// How an Electron accelerator is written for the user. Pure: main's menus and the renderers' texts share it.

const MAC_MODIFIERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(Ctrl|Control)$/, '⌃'],
  [/^(Alt|Option)$/, '⌥'],
  [/^Shift$/, '⇧'],
  [/^(Cmd|Command|CmdOrCtrl|CommandOrControl)$/, '⌘'],
];

/** An Electron accelerator as the platform writes it: 'Ctrl+Shift+F' on Windows and Linux, '⇧⌘F' on macOS. */
export function acceleratorLabel(accelerator: string, platform: string): string {
  const parts = accelerator.split('+');
  // '+' itself as the key leaves an empty last part
  const key = parts.at(-1) === '' ? '+' : parts.at(-1)!;
  const modifiers = parts.slice(0, parts.at(-1) === '' ? -2 : -1);
  if (platform !== 'darwin') return [...modifiers.map((modifier) => (/^(CmdOrCtrl|CommandOrControl|Control)$/.test(modifier) ? 'Ctrl' : modifier)), key].join('+');
  const symbols = MAC_MODIFIERS.flatMap(([pattern, symbol]) => (modifiers.some((modifier) => pattern.test(modifier)) ? [symbol] : []));
  return symbols.join('') + key;
}
