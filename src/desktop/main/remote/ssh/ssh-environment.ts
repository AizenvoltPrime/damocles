// The two e2e hooks of the SSH transport, honored only in a development build run with DAMOCLES_E2E_HOOKS=1; a packaged
// build reads neither, so nothing else about ssh can be redirected.
import * as path from 'node:path';
import { defaultSshConfigSource, listSshConfigHosts, passwdAccount, type SshAccount, type SshConfigSource } from './ssh-config';

export interface SshEnvironment {
  // DAMOCLES_E2E_SSH_CONFIG: passed to every ssh as -F, and the file the alias list reads
  readonly configFile?: string;
  // DAMOCLES_E2E_RELEASE_URL: replaces the release base the target downloads from
  readonly releasesUrl?: string;
}

export function sshEnvironment(options: { readonly packaged: boolean; readonly env: Readonly<Record<string, string | undefined>> }): SshEnvironment {
  if (options.packaged || options.env['DAMOCLES_E2E_HOOKS'] !== '1') return {};
  const configFile = options.env['DAMOCLES_E2E_SSH_CONFIG'];
  const releasesUrl = options.env['DAMOCLES_E2E_RELEASE_URL'];
  if (configFile !== undefined && !path.isAbsolute(configFile)) throw new Error('DAMOCLES_E2E_SSH_CONFIG must be an absolute path');
  if (releasesUrl !== undefined && !/^https?:\/\/[^\s"']+$/.test(releasesUrl)) throw new Error('DAMOCLES_E2E_RELEASE_URL must be an http or https URL');
  return {
    ...(configFile !== undefined ? { configFile } : {}),
    ...(releasesUrl !== undefined ? { releasesUrl: releasesUrl.replace(/\/+$/, '') } : {}),
  };
}

/** The files the alias list reads: the e2e hook's file alone, as `ssh -F` reads it, else ssh's default files. */
export function sshConfigSourceFor(environment: SshEnvironment, account: SshAccount, platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): SshConfigSource {
  return environment.configFile !== undefined ? { userConfig: environment.configFile, account, platform, env } : defaultSshConfigSource(account, platform, env);
}

/** The Connect dialog's aliases; none for an account without a passwd entry, for which ssh itself exits before reading any. */
export async function configuredAliases(
  environment: SshEnvironment,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
  userInfo?: () => SshAccount,
): Promise<string[]> {
  const account = passwdAccount((line) => log(`[ssh-config] ${line}`), userInfo);
  return account ? listSshConfigHosts(sshConfigSourceFor(environment, account, platform, env), log) : [];
}
