import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { readTarGz } from '../../../scripts/server-archive.ts';
import type { DesktopApp } from '../../desktop/support/app';
import { shellPage } from '../../desktop/support/shell';
import { activeTerminal } from '../../desktop/support/terminal';
import { LINUX_TARGET, SERVER_PACKAGES_DIR, serverPackage, serverVersionOf } from './release-mirror';
import { expect, remoteProjectKey } from './remote';
import { runProgram, TARGET_HOME, type SshdFixture } from './sshd';

// Another build's server on the target: unpacked where stage 1 would have installed it, so a launch running as that build
// finds it and starts its daemon, and the updated app meets that daemon running.

/** This tree's server package for the fixture's target. */
export const CURRENT_PACKAGE: string = path.join(SERVER_PACKAGES_DIR, serverPackage(LINUX_TARGET));
/** The version the app before an update runs, and the server version CURRENT_PACKAGE installed as it stands for. */
export const OLD = '3.6.9';
const SWITCHED_PROJECT = '/srv/app';

const DAEMON_SERVE = /\/\.damocles\/server\/([^/]+)-[a-z]+-(?:x64|arm64)\/node\/node .*\/dist\/daemon\.js serve\b/;

/** The install folder of server version `version` in the target account's default install. */
export const versionFolder = (version: string): string => `${TARGET_HOME}/.damocles/server/${version}-${LINUX_TARGET}`;

/** The server version of every running daemon of the account, from its program's install folder. */
export async function daemonVersions(fixture: Pick<SshdFixture, 'userProcesses'>): Promise<string[]> {
  return (await fixture.userProcesses()).flatMap((line) => DAEMON_SERVE.exec(line)?.[1] ?? []);
}

const packageEntries = (archive: string): Array<{ path: string; data: Buffer }> => readTarGz(fs.readFileSync(archive)) as Array<{ path: string; data: Buffer }>;

/** The server version `archive` installs as: its server-package.json's serverVersion, or the version of a package built before it had one. */
export function packageVersion(archive: string): string {
  const info = packageEntries(archive).find((entry) => entry.path === 'server-package.json');
  if (info === undefined) throw new Error(`${archive} is no server package`);
  const { serverVersion, version } = JSON.parse(info.data.toString('utf8')) as { serverVersion?: string; version?: string };
  const found = serverVersion ?? version;
  if (found === undefined) throw new Error(`${archive}'s server-package.json names no version`);
  return found;
}

export interface TerminalHostProcess {
  /** The host's server version. */
  readonly version: string;
  readonly pid: number;
  readonly socketFolder: string | null;
}

/** The account's terminal hosts: each record of a run folder's terminal-hosts/ whose process lives. */
export async function terminalHosts(fixture: Pick<SshdFixture, 'sh'>): Promise<TerminalHostProcess[]> {
  const records = await fixture.sh(`for f in ${TARGET_HOME}/.damocles/server/run-*/terminal-hosts/*.json; do [ -e "$f" ] || continue; p=\${f##*/}; kill -0 "\${p%.json}" 2>/dev/null || continue; cat "$f"; printf '\\n@@\\n'; done; true`, 'dev');
  return records.split('\n@@\n').filter((record) => record.trim() !== '').map((record) => JSON.parse(record) as TerminalHostProcess);
}

/** The server version of every live terminal host of the account, sorted. */
export async function terminalHostVersions(fixture: Pick<SshdFixture, 'sh'>): Promise<string[]> {
  return (await terminalHosts(fixture)).map((host) => host.version).sort();
}

export interface OlderServerOptions {
  /** Rewrites the package's own server version, for a copy of this tree's package standing in for an older build. */
  readonly version?: string;
  /** Rewrites the daemon bundle's PROTOCOL_VERSION, for a daemon of another protocol. */
  readonly protocolVersion?: number;
  /**
   * Drops this name from the daemon bundle's FEATURES and FROZEN_FEATURES, for a daemon built before that contract: neither
   * its welcome nor its refusal lists it. Without 'control.handOver' the app takes the legacy path (shutdownWhenIdle, which a
   * terminal holds back, and shutdownNow, which ends the terminals).
   */
  readonly withoutFeature?: string;
  /**
   * Writes this minimum server version into the package's server-package.json, as a release that requires it builds its
   * packages: the package's daemon raises the host's security floor to it.
   */
  readonly minimumServerVersion?: string;
}

/** The host's security floor in the target account's default install; '' when no daemon raised one. */
export const securityFloor = async (fixture: Pick<SshdFixture, 'sh'>): Promise<string> => (await fixture.sh(`cat ${TARGET_HOME}/.damocles/server/security-floor 2>/dev/null || true`, 'dev')).trim();

/** Unpacks `archive` into its server version's install folder on the target, as the target account; resolves with that version. */
export async function installOlderServer(fixture: SshdFixture, archive: string, options: OlderServerOptions = {}): Promise<string> {
  const version = options.version ?? packageVersion(archive);
  const copied = await runProgram('docker', ['cp', archive, `${fixture.container}:/tmp/older-server.tar.gz`]);
  if (copied.code !== 0) throw new Error(`docker cp ${archive} failed: ${copied.stderr}`);
  await fixture.sh('chmod 644 /tmp/older-server.tar.gz');
  const folder = versionFolder(version);
  await fixture.sh(`mkdir -p '${folder}' && tar -xzf /tmp/older-server.tar.gz -C '${folder}'`, 'dev');
  await fixture.sh('rm -f /tmp/older-server.tar.gz');
  // the package's own Node edits it, so no JSON or bundle text goes through sed
  const node = `'${folder}/node/node'`;
  const rewrite = (fields: string) => `const fs=require('fs');const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,'utf8'));${fields};fs.writeFileSync(f,JSON.stringify(p,null,2))`;
  if (options.version !== undefined) {
    // package.json and server-package.json name the app version; the daemon runs as server-package.json's serverVersion
    const appVersion = options.version.split('+')[0]!;
    await fixture.sh(`${node} -e "${rewrite('p.version=process.argv[2]')}" '${folder}/package.json' '${appVersion}'`, 'dev');
    await fixture.sh(`${node} -e "${rewrite('p.version=process.argv[2];p.serverVersion=process.argv[3]')}" '${folder}/server-package.json' '${appVersion}' '${options.version}'`, 'dev');
  }
  if (options.minimumServerVersion !== undefined) {
    await fixture.sh(`${node} -e "${rewrite('p.minimumServerVersion=process.argv[2]')}" '${folder}/server-package.json' '${options.minimumServerVersion}'`, 'dev');
  }
  if (options.protocolVersion !== undefined) {
    const script = `const fs=require('fs');const f=process.argv[1];const t=fs.readFileSync(f,'utf8');const m=t.match(/\\bPROTOCOL_VERSION = 1;/g)||[];if(m.length!==1)throw new Error('PROTOCOL_VERSION = 1; occurs '+m.length+' times');fs.writeFileSync(f,t.replace(/\\bPROTOCOL_VERSION = 1;/,'PROTOCOL_VERSION = '+process.argv[2]+';'))`;
    await fixture.sh(`${node} -e "${script}" '${folder}/dist/daemon.js' '${options.protocolVersion}'`, 'dev');
  }
  if (options.withoutFeature !== undefined) {
    // the bundle's one `FEATURES = [...]` list (\b keeps CORE_READ_FEATURES and FROZEN_FEATURES out) must hold the name; its
    // FROZEN_FEATURES list, which a package built before it lacks, loses the name when it holds it. No double quote may
    // appear in the script, which sh -c reads inside a pair.
    const script = `const fs=require('fs');const f=process.argv[1];const name=process.argv[2];let t=fs.readFileSync(f,'utf8');const strip=(label,pattern,required)=>{const lists=[...t.matchAll(pattern)];if(lists.length>1||(required&&lists.length!==1))throw new Error(label+' = [ occurs '+lists.length+' times');if(lists.length===0)return;const names=JSON.parse('['+lists[0][1]+']');const left=names.filter((entry)=>entry!==name);if(required&&left.length!==names.length-1)throw new Error(name+' is not one entry of '+label);t=t.slice(0,lists[0].index)+label+' = '+JSON.stringify(left)+t.slice(lists[0].index+lists[0][0].length)};strip('FEATURES',/\\bFEATURES = \\[([^\\]]*)\\]/g,true);strip('FROZEN_FEATURES',/\\bFROZEN_FEATURES = \\[([^\\]]*)\\]/g,false);fs.writeFileSync(f,t)`;
    await fixture.sh(`${node} -e "${script}" '${folder}/dist/daemon.js' '${options.withoutFeature}'`, 'dev');
  }
  return version;
}

/**
 * The app of this version connects to /srv/app on the host, where this version's server runs once the idle OLD server handed
 * over (or none ran), and the active terminal is back in its tab, its shell still in OLD's terminal host, which it adopted.
 */
export async function switchToThisVersion(launch: (options: { env: Record<string, string> }) => Promise<DesktopApp>, env: Record<string, string>, hostId: string, fixture: SshdFixture): Promise<ElectronApplication> {
  const { app } = await launch({ env });
  await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([serverVersionOf(LINUX_TARGET)]);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, SWITCHED_PROJECT);
  await expect(activeTerminal(await shellPage(app))).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  expect(await terminalHostVersions(fixture)).toEqual([OLD]);
  return app;
}
