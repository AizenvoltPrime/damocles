// WSL's own rule for a distro name (wsl --import refuses any other); a leading '-' would read as an option of wsl.exe, and a
// name of dots alone would name a parent folder in a \\wsl.localhost path.
const DISTRO_NAME = /^(?!\.+$)[A-Za-z0-9._][A-Za-z0-9._-]{0,127}$/;

/** Whether value is a WSL distro name as wsl.exe takes it after -d. */
export function isWslDistroName(value: unknown): value is string {
  return typeof value === 'string' && DISTRO_NAME.test(value);
}
