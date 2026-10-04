// A stable hue per project name, so a project keeps its colour across restarts and windows.
export function avatarHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % 360;
}

export function avatarInitial(name: string): string {
  const first = [...name.trim()][0];
  return first === undefined ? '?' : first.toLocaleUpperCase();
}
