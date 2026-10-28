/** A path as ssh's ControlPath or IdentityFile value: ssh expands `%` tokens in both, so each literal `%` is doubled. */
export function sshPercentLiteral(file: string): string {
  return file.replaceAll('%', '%%');
}
