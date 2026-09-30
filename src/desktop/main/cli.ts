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
