import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asConfigArgs, asConfigPairs, asConfigParams, managedEntries } from '../askpass/credential-config';
import { relayHelperConfig } from '../askpass/credential-relay';
import { createGitRunner } from '../git-runner';
import { GIT_PATH, HAS_GIT, folder, useGitSandbox } from './git-harness';

// The takeover's entries against real git: a temp global config with recording helpers stands in for the user's own.
useGitSandbox();

const GITLAB = { webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'] };

interface World {
  readonly dir: string;
  readonly log: string;
  readonly damocles: string;
  readonly env: NodeJS.ProcessEnv;
}

/** A helper script that logs `<name> <arguments>` and git's input, and answers get with its own credential unless told not to. */
function helperScript(dir: string, name: string, log: string, answers: boolean): string {
  const file = path.join(dir, `${name}.sh`);
  const body = [
    '#!/bin/sh',
    `input=$(cat)`,
    // git passes the operation last
    'for op; do :; done',
    `printf '%s %s\\n' '${name}' "$*" >> '${log.replaceAll('\\', '/')}'`,
    `printf '%s\\n' "$input" | sed 's/^/  /' >> '${log.replaceAll('\\', '/')}'`,
    ...(answers ? ['if [ "$op" = get ]; then printf \'username=%s\\npassword=%s\\n\' ' + `'${name}-user' '${name}-secret'; fi`] : []),
  ];
  fs.writeFileSync(file, `${body.join('\n')}\n`, { mode: 0o755 });
  return file;
}

function world(damoclesAnswers = true): World {
  const dir = folder('cred');
  const log = path.join(dir, 'helpers.log');
  fs.writeFileSync(log, '');
  const user = helperScript(dir, 'user-helper', log, true);
  const scoped = helperScript(dir, 'user-gitlab-helper', log, true);
  const damocles = helperScript(dir, 'damocles', log, damoclesAnswers);
  const global = path.join(dir, 'global.gitconfig');
  const q = (file: string): string => `!'${file.replaceAll('\\', '/')}'`;
  fs.writeFileSync(global, `[credential]\n\thelper = "${q(user)}"\n[credential "https://gitlab.com"]\n\thelper = "${q(scoped)}"\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_TERMINAL_PROMPT: '0', HOME: dir, USERPROFILE: dir };
  for (const key of Object.keys(env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMS)$/.test(key)) delete env[key];
  return { dir, log, damocles: damocles.replaceAll('\\', '/'), env };
}

function fill(w: World, url: { host: string; path: string }, env: NodeJS.ProcessEnv, args: readonly string[] = []): string {
  return execFileSync(GIT_PATH!, [...args, 'credential', 'fill'], { cwd: w.dir, env, input: `protocol=https\nhost=${url.host}\npath=${url.path}\n\n`, encoding: 'utf8' });
}

const calls = (w: World): string[] => fs.readFileSync(w.log, 'utf8').split('\n').filter((line) => !line.startsWith('  ') && line !== '');

describe.skipIf(!HAS_GIT)('the credential takeover against real git', () => {
  it('GIT_CONFIG_COUNT: only Damocles\' helper answers a managed server, with the path; the user\'s answers others', () => {
    const w = world();
    const env = { ...w.env, ...asConfigPairs(managedEntries([GITLAB], w.damocles)) };
    expect(fill(w, { host: 'gitlab.com', path: 'grp/sub/proj.git' }, env)).toContain('password=damocles-secret');
    expect(calls(w)).toEqual(['damocles --takeover get']);
    expect(fs.readFileSync(w.log, 'utf8')).toContain('  path=grp/sub/proj.git');
    fs.writeFileSync(w.log, '');
    expect(fill(w, { host: 'github.com', path: 'o/r.git' }, env)).toContain('password=user-helper-secret');
    expect(calls(w)).toEqual(['user-helper get']);
    // without useHttpPath git drops the path before the user's helper hears it
    expect(fs.readFileSync(w.log, 'utf8')).not.toContain('path=');
  });

  it('GIT_CONFIG_PARAMETERS: the same, appended to an inherited value, and get-urlmatch lists only Damocles\' helper', () => {
    const w = world();
    const params = asConfigParams(managedEntries([GITLAB], w.damocles), "'core.askpass='");
    const env = { ...w.env, GIT_CONFIG_PARAMETERS: params };
    expect(fill(w, { host: 'gitlab.com', path: 'grp/proj.git' }, env)).toContain('password=damocles-secret');
    expect(calls(w)).toEqual(['damocles --takeover get']);
    const urlmatch = execFileSync(GIT_PATH!, ['config', '--get-urlmatch', 'credential.helper', 'https://gitlab.com/x'], { cwd: w.dir, env, encoding: 'utf8' }).trim();
    expect(urlmatch).toBe(`!'${w.damocles}' --takeover`);
  });

  it('orders a daemon relay pair in GIT_CONFIG_COUNT before the takeover in GIT_CONFIG_PARAMETERS, and a later -c after it', () => {
    const w = world(false);
    const relay = helperScript(w.dir, 'relay', w.log, true).replaceAll('\\', '/');
    const late = helperScript(w.dir, 'late', w.log, true).replaceAll('\\', '/');
    const env = { ...w.env, ...asConfigPairs([relayHelperConfig({ helper: relay })]), GIT_CONFIG_PARAMETERS: asConfigParams(managedEntries([GITLAB], w.damocles), undefined) };
    // the reset drops the user's helpers and the relay pair for gitlab.com; -c comes after the takeover
    expect(fill(w, { host: 'gitlab.com', path: 'grp/proj.git' }, env, ['-c', `credential.helper=!'${late}'`])).toContain('password=late-secret');
    expect(calls(w)).toEqual(['damocles --takeover get', 'late get']);
    fs.writeFileSync(w.log, '');
    // an unmanaged server keeps the user's helper first and the relay after it
    const filled = execFileSync(GIT_PATH!, ['credential', 'fill'], { cwd: w.dir, env: { ...env, GIT_CONFIG_GLOBAL: path.join(w.dir, 'empty.gitconfig') }, input: 'protocol=https\nhost=github.com\npath=o/r.git\n\n', encoding: 'utf8' });
    expect(filled).toContain('password=relay-secret');
    expect(calls(w)).toEqual(['relay get']);
  });

  it('-c (git before 2.31): the reset, helper and useHttpPath take effect the same way', () => {
    const w = world();
    expect(fill(w, { host: 'gitlab.com', path: 'grp/proj.git' }, w.env, asConfigArgs(managedEntries([GITLAB], w.damocles)))).toContain('password=damocles-secret');
    expect(calls(w)).toEqual(['damocles --takeover get']);
    expect(fs.readFileSync(w.log, 'utf8')).toContain('  path=grp/proj.git');
  });

  it('an engine call\'s environment: the takeover last, after the engine pairs, the call\'s and a relay pair, with no empty value', () => {
    const w = world();
    const relay = helperScript(w.dir, 'relay', w.log, true).replaceAll('\\', '/');
    const runner = createGitRunner({ git: { path: GIT_PATH!, version: { major: 2, minor: 56, patch: 0 } }, log: { appendLine: () => undefined }, isTrusted: () => true });
    const saved = { global: process.env['GIT_CONFIG_GLOBAL'], params: process.env['GIT_CONFIG_PARAMETERS'] };
    process.env['GIT_CONFIG_GLOBAL'] = w.env['GIT_CONFIG_GLOBAL'];
    process.env['GIT_CONFIG_PARAMETERS'] = "'core.pager=less'";
    let env: NodeJS.ProcessEnv;
    try {
      env = runner.envFor({ kind: 'mutation', config: [['submodule.a.ignore', 'all']] }, {
        relay: { helper: relay, node: '/n', main: '/m', handle: '/h', nonce: 'e'.repeat(64) },
        takeover: { env: { DAMOCLES_CREDENTIAL_NONCE: 'f'.repeat(64) }, entries: managedEntries([GITLAB], w.damocles) },
      });
    } finally {
      process.env['GIT_CONFIG_GLOBAL'] = saved.global;
      if (saved.params === undefined) delete process.env['GIT_CONFIG_PARAMETERS'];
      else process.env['GIT_CONFIG_PARAMETERS'] = saved.params;
    }
    // an empty variable the test process itself carries is the user's, not the engine's
    expect(Object.entries(env).filter(([key, value]) => value === '' && process.env[key] !== '')).toEqual([]);
    // childEnv drops an inherited GIT_CONFIG_PARAMETERS, as git's local_repo_env does, so the takeover is all it holds
    expect(env['GIT_CONFIG_PARAMETERS']).toBe(asConfigParams(managedEntries([GITLAB], w.damocles), undefined));
    expect(env['GIT_CONFIG_COUNT']).toBe('3');
    const urlmatch = (url: string): string => execFileSync(GIT_PATH!, ['config', '--get-urlmatch', 'credential.helper', url], { cwd: w.dir, env, encoding: 'utf8' }).trim();
    expect(urlmatch('https://gitlab.com/x')).toBe(`!'${w.damocles}' --takeover`);
    expect(urlmatch('https://github.com/x')).toBe(`!'${relay}'`);
    expect(fill(w, { host: 'gitlab.com', path: 'g/p.git' }, env)).toContain('password=damocles-secret');
    expect(calls(w)).toEqual(['damocles --takeover get']);
  });

  it('runs a helper whose path holds a quote, a bang and a space, through GIT_CONFIG_PARAMETERS', () => {
    const w = world();
    const odd = path.join(w.dir, "Dam's !dir");
    fs.mkdirSync(odd);
    const helper = helperScript(odd, 'odd', w.log, true).replaceAll('\\', '/');
    const env = { ...w.env, GIT_CONFIG_PARAMETERS: asConfigParams(managedEntries([GITLAB], helper), undefined) };
    expect(execFileSync(GIT_PATH!, ['config', '--get-urlmatch', 'credential.helper', 'https://gitlab.com/x'], { cwd: w.dir, env, encoding: 'utf8' }).trim()).toBe(`!'${helper.replaceAll("'", "'\\''")}' --takeover`);
    expect(fill(w, { host: 'gitlab.com', path: 'g/p.git' }, env)).toContain('password=odd-secret');
    expect(calls(w)).toEqual(['odd --takeover get']);
  });

  it.runIf(process.platform === 'win32')('runs a .cmd helper through Git for Windows\' sh, as the desktop app\'s helper is', () => {
    const w = world();
    const cmd = path.join(w.dir, 'helper dir', 'git-credential-relay.cmd');
    fs.mkdirSync(path.dirname(cmd));
    fs.writeFileSync(cmd, '@echo off\r\nif "%1 %2"=="--takeover get" (\r\necho username=cmd-user\r\necho password=cmd-secret\r\n)\r\n');
    const env = { ...w.env, GIT_CONFIG_PARAMETERS: asConfigParams(managedEntries([GITLAB], cmd), undefined) };
    expect(fill(w, { host: 'gitlab.com', path: 'g/p.git' }, env)).toContain('password=cmd-secret');
    expect(calls(w)).toEqual([]);
  });

  it('a path prefix limits the takeover to the server under it on a shared host', () => {
    const w = world();
    const env = { ...w.env, GIT_CONFIG_PARAMETERS: asConfigParams(managedEntries([{ webUrl: 'https://gitlab.com/team', gitHosts: ['gitlab.com'] }], w.damocles), undefined) };
    expect(fill(w, { host: 'gitlab.com', path: 'team/proj.git' }, env)).toContain('password=damocles-secret');
    fs.writeFileSync(w.log, '');
    expect(fill(w, { host: 'gitlab.com', path: 'other/proj.git' }, env)).toContain('password=user-helper-secret');
    expect(calls(w)).toEqual(['user-helper get']);
  });
});
