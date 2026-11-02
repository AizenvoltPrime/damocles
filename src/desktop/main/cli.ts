const USER_DATA_FLAG = '--user-data-dir';

/** `--user-data-dir <path>` or `--user-data-dir=<path>`. */
export function parseUserDataDir(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === USER_DATA_FLAG) return argv[index + 1];
    if (arg.startsWith(`${USER_DATA_FLAG}=`)) return arg.slice(USER_DATA_FLAG.length + 1);
  }
  return undefined;
}

const CLI_PATH_FLAG = '--cli-path';

/** `--cli-path add|remove`, which the Windows installer and uninstaller run; invalid for any other value, undefined without one. */
export function parseCliPathAction(argv: readonly string[]): 'add' | 'remove' | 'invalid' | undefined {
  const at = argv.indexOf(CLI_PATH_FLAG);
  if (at === -1) return undefined;
  const action = argv[at + 1];
  return action === 'add' || action === 'remove' ? action : 'invalid';
}
