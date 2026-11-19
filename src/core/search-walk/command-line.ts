/** The length libuv gives arg on a Windows command line (`quote_cmd_arg`): quoted when it holds a space, tab or `"`, or is empty. */
export function commandLineLength(arg: string): number {
  if (arg === '') return 2;
  if (!/[ \t"]/.test(arg)) return arg.length;
  if (!/["\\]/.test(arg)) return arg.length + 2;
  let extra = 2;
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes++;
      continue;
    }
    // backslashes before a quote are doubled, and the quote is escaped
    if (char === '"') extra += backslashes + 1;
    backslashes = 0;
  }
  // and so are those before the closing quote
  return arg.length + extra + backslashes;
}

/**
 * What arg adds to a command line, in the units BATCH_COMMAND_LINE counts: on Windows its quoted length and the space or NUL after
 * it, in UTF-16 units; elsewhere its UTF-8 bytes, its NUL and its argv pointer, as execve counts them against ARG_MAX.
 */
export function commandLineCost(arg: string, platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? commandLineLength(arg) + 1 : Buffer.byteLength(arg, 'utf8') + 1 + 8;
}

// A batch's whole rg command line, in commandLineCost's units: CreateProcessW stalls near its 32,767 units (docs/invariants.md
// "Tool overrides"); POSIX argv and environment share ARG_MAX, never below 128 KiB on Linux (docs/perf.md "Search: walked batches
// against ripgrep's walk").
export const BATCH_COMMAND_LINE: number = process.platform === 'win32' ? 32_000 : 96 * 1024;
