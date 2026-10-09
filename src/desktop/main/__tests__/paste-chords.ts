// Every modifier combination of V on each platform, with whether it is a terminal paste key; main's before-input-event and
// the shell's key handler are both tested against it.
const PLATFORMS = ['win32', 'linux', 'darwin'] as const;
const FLAGS = [false, true] as const;

function pastes(platform: (typeof PLATFORMS)[number], control: boolean, shift: boolean, alt: boolean, meta: boolean): boolean {
  if (!control || alt || meta) return false;
  return platform === 'win32' || (platform === 'linux' && shift);
}

export const PASTE_CHORD_CASES: ReadonlyArray<readonly [(typeof PLATFORMS)[number], boolean, boolean, boolean, boolean, boolean]> = PLATFORMS.flatMap((platform) =>
  FLAGS.flatMap((control) => FLAGS.flatMap((shift) => FLAGS.flatMap((alt) => FLAGS.map((meta) => [platform, control, shift, alt, meta, pastes(platform, control, shift, alt, meta)] as const)))));
