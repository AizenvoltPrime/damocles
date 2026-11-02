// dist/cli-remote.js: the damocles command in a target's user terminal, run by the server package's own Node from
// bin/remote-cli/damocles and, with --open-external, bin/helpers/browser.sh. It sends one request to the terminal's CLI socket
// (DAMOCLES_CLI_HOOK); its own messages use the language of the client that most recently attached the terminal's view.
import { readFileSync } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { argErrorText, openItem, parseArgs, usageText } from './args';
import { cliRequestLimit, sendCliRequest, type CliAnswer, type CliLanguage, type CliRequest } from './cli-protocol';
import { limitText, translator, type Translate } from './cli-text';
import { CLI_HOOK_ENV } from '../workspace/terminal/terminal-env';

export interface RemoteCliIo {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  // the server package root, holding package.json and l10n/
  readonly root: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly connect: (hook: string) => net.Socket;
}

/** Runs the command; resolves its exit code. */
export async function runRemoteCli(io: RemoteCliIo): Promise<number> {
  const text = (language: CliLanguage): Translate => translator(language, path.join(io.root, 'l10n'), (file) => readFileSync(file, 'utf8'));
  // what the command says before it knows a client's language
  const en = { t: text('en') };
  const parsed = parseArgs(io.argv, 'remote');
  if (parsed.kind === 'version') {
    io.out(`${readVersion(io.root)}\n`);
    return 0;
  }
  const hook = io.env[CLI_HOOK_ENV];
  if (!hook) {
    io.err(`${en.t('damocles: run this command in a terminal Damocles opened on this host.')}\n`);
    return 1;
  }
  const send = async (request: CliRequest): Promise<CliAnswer | undefined> => {
    try {
      return await sendCliRequest(() => io.connect(hook), request);
    } catch (err) {
      io.err(`${en.t('damocles: Damocles cannot be reached from this terminal: {0}', err instanceof Error ? err.message : String(err))}\n`);
      return undefined;
    }
  };
  // the usage and argument errors need the attached client's language, which only the socket knows
  const language = async (): Promise<CliLanguage | undefined> => {
    const status = await send({ kind: 'status' });
    if (!status) return undefined;
    if (status.ok && 'language' in status) return status.language;
    if (!status.ok && status.code === 'refused') io.err(`${status.message}\n`);
    else io.err(`${en.t('damocles: Damocles refused the request ({0}).', status.ok ? 'status' : status.code)}\n`);
    return undefined;
  };
  if (parsed.kind === 'help' || parsed.kind === 'error' || (parsed.kind === 'open' && parsed.paths.length === 0)) {
    const known = await language();
    if (known === undefined) return 1;
    const t = text(known);
    if (parsed.kind === 'error') {
      io.err(`${argErrorText(parsed.error, t)}\n`);
      return 1;
    }
    io.out(`${usageText(t)}\n`);
    return 0;
  }
  const absolute = (value: string): string => path.resolve(io.cwd, value);
  const request: CliRequest = parsed.kind === 'openExternal'
    ? { kind: 'openExternal', url: parsed.url }
    : parsed.kind === 'diff'
      ? { kind: 'diff', cwd: io.cwd, left: absolute(parsed.left), right: absolute(parsed.right), wait: parsed.wait }
      : { kind: 'open', cwd: io.cwd, items: parsed.paths.map((value) => openItem(absolute(value))), wait: parsed.wait };
  // the socket would refuse it only as malformed or too large, so the command names the bound first
  const limit = cliRequestLimit(request, Buffer.byteLength(JSON.stringify(request)));
  if (limit !== undefined) {
    const known = await language();
    if (known !== undefined) io.err(`${limitText(limit, text(known))}\n`);
    return 1;
  }
  const answer = await send(request);
  if (!answer) return 1;
  if (answer.ok) return 0;
  switch (answer.code) {
    case 'notConnected': {
      const last = { t: text(answer.language) };
      io.err(`${last.t('damocles: Damocles is not connected to this host.')}\n`);
      break;
    }
    case 'refused':
      io.err(`${answer.message}\n`);
      break;
    case 'tooLarge':
      io.err(`${en.t('damocles: the request is over 64 KiB. Name fewer or shorter paths.')}\n`);
      break;
    case 'malformed':
    case 'oneRequest':
      io.err(`${en.t('damocles: Damocles refused the request ({0}).', answer.code)}\n`);
      break;
  }
  return 1;
}

function readVersion(root: string): string {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string') throw new Error(`${root}/package.json names no version`);
  return manifest.version;
}

if (require.main === module) {
  // the bundle is dist/cli-remote.js; its package root holds package.json and l10n/
  void runRemoteCli({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    root: path.resolve(__dirname, '..'),
    out: (value) => process.stdout.write(value),
    err: (value) => process.stderr.write(value),
    connect: (hook) => net.connect(hook),
  }).then((code) => {
    process.exitCode = code;
  });
}
