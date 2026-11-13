import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HermeticHome } from './hermetic';

// The user's own git credential helper, recorded: a sh script that appends each call git makes to a log and answers `get` for
// the hosts it was given. It is installed only in a temp global config the launch names with GIT_CONFIG_GLOBAL, so the
// developer's own git config and credential manager are never read or written (GIT_CONFIG_NOSYSTEM is set in every launch).

export interface RecordedCredentialCall {
  readonly op: string;
  readonly protocol: string;
  /** host[:port] as git sent it */
  readonly host: string;
  readonly path: string;
}

export interface RecordingCredentialHelper {
  /** The temp global git config holding the helper; the app gets it as GIT_CONFIG_GLOBAL. */
  readonly globalConfig: string;
  /** Every call git made, in order. */
  calls(): RecordedCredentialCall[];
}

export interface RecordingHelperOptions {
  /** What `get` answers per host[:port]; any other host gets no answer. */
  readonly answers: Readonly<Record<string, { readonly username: string; readonly password: string }>>;
  /** The CA file git and Git LFS trust for https (the forge stub's test CA). */
  readonly caFile?: string;
}

// single-quoted for sh, so no character in it is special
const shQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
// git runs a helper through its own sh, on Windows too, which takes forward slashes
const posix = (file: string): string => file.split(path.sep).join('/');

export function recordingCredentialHelper(home: Pick<HermeticHome, 'root'>, options: RecordingHelperOptions): RecordingCredentialHelper {
  const dir = path.join(home.root, 'recording-helper');
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  const answers = Object.entries(options.answers).map(([host, { username, password }]) =>
    `    ${shQuote(host)}) printf 'username=%s\\npassword=%s\\n' ${shQuote(username)} ${shQuote(password)} ;;`);
  const script = [
    '#!/bin/sh',
    'op="$1"; protocol=; host=; path=',
    'while IFS= read -r line; do',
    '  case "$line" in',
    '    protocol=*) protocol="${line#protocol=}" ;;',
    '    host=*) host="${line#host=}" ;;',
    '    path=*) path="${line#path=}" ;;',
    "    '') break ;;",
    '  esac',
    'done',
    `printf '%s\\t%s\\t%s\\t%s\\n' "$op" "$protocol" "$host" "$path" >> ${shQuote(posix(log))}`,
    'if [ "$op" = get ]; then',
    '  case "$host" in',
    ...answers,
    '  esac',
    'fi',
    '',
  ].join('\n');
  const helper = path.join(dir, 'recorder.sh');
  fs.writeFileSync(helper, script, { mode: 0o755 });
  const globalConfig = path.join(dir, 'gitconfig');
  const lines = [
    '[credential]',
    `\thelper = "!${shQuote(posix(helper)).replace(/"/g, '\\"')}"`,
    '[user]',
    '\tname = Forge Tester',
    '\temail = forge@example.com',
    ...(options.caFile !== undefined ? ['[http]', `\tsslCAInfo = ${posix(options.caFile)}`, ...(process.platform === 'win32' ? ['\tsslBackend = openssl'] : [])] : []),
    '',
  ];
  fs.writeFileSync(globalConfig, lines.join('\n'));
  return {
    globalConfig,
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => {
      const [op = '', protocol = '', host = '', callPath = ''] = line.split('\t');
      return { op, protocol, host, path: callPath };
    }),
  };
}
